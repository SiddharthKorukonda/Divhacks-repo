import os, json, re, time
from typing import TypedDict, Literal, List, Dict, Any, Optional
from pydantic import BaseModel, Field, ValidationError
# Load local .env into the environment for development
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    # If python-dotenv isn't installed, environment variables must be provided by the shell
    pass
import google.generativeai as genai
from tavily import TavilyClient
from langgraph.graph import StateGraph, END, START
from langgraph.checkpoint.memory import MemorySaver
import opik
opik.configure(
    api_key=os.getenv("OPIK_API_KEY"),
    workspace=os.getenv("OPIK_WORKSPACE"),
    use_local=False)  # cloud; omit/adjust for self-hosted
from opik.integrations.langchain import OpikTracer
from langchain_core.messages import HumanMessage

# Client Configuration
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
if not GOOGLE_API_KEY:
    raise RuntimeError("Missing GOOGLE_API_KEY environment variable. Set it before running.")
genai.configure(api_key=GOOGLE_API_KEY)

GEMINI_CLASSIFY_MODEL = "gemini-2.5-flash"
GEMINI_ASSESS_MODEL   = "gemini-2.5-pro"

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")
if not TAVILY_API_KEY:
    raise RuntimeError("Missing TAVILY_API_KEY environment variable. Set it before running.")
tavily = TavilyClient(api_key=TAVILY_API_KEY)

# State definition for LangGraph agent
class AgentState(TypedDict, total=False):
    input_text: str
    is_claim : bool
    claim_reason: str
    research: List[Dict[str, str]]
    verdict: Literal["True", "False", "unsubstantiated", "not_a_claim"]
    explanation: str
    citations: List[Dict[str, str]]

# Validation for I/O
class ClaimJudge(BaseModel):
    is_claim: bool = Field(..., description="True if the text asserts a factual, checkable claim.")
    reason: str = Field(None, description="Short rationale.")
class VerdictOut(BaseModel):
    verdict: Literal["true", "false", "unsubstantiated"]
    explanation: str = Field(..., max_length=600)
    citations: List[Dict[str, str]] = Field(default_factory=list)


# Helpers for LangGraph
def gemini_json(model: str, prompt: str, temperature: float = 0.1, retries: int = 2) -> dict:

    """
    Call Gemini and return parsed JSON. Retries with stricter reminder if parsing fails.
    """
    sys = (
        "You are a function that returns JSON only. "
        "Do not include markdown fences or extra text. "
        "Return a single JSON object that validates against the caller's expectations."
    )
    messages = [{"role": "user", "parts": [prompt]}]  # system-style goes in prompt for gemini SDK

    for attempt in range(retries + 1):
        resp = genai.GenerativeModel(model).generate_content(
            messages,
            generation_config={"temperature": temperature},
        )
        text = (resp.text or "").strip()
        # Strip code fences if present
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.DOTALL)
        try:
            return json.loads(text)
        except Exception:
            if attempt == retries:
                raise
            # tighten instruction and try again
            messages = [{"role": "user", "parts": [prompt + "\n\nReturn ONLY valid JSON, no prose."]}]
            time.sleep(0.3)
def normalize_research(items: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out = []
    for r in items or []:
        out.append({
            "title": r.get("title") or "(no title)",
            "url": r.get("url") or "",
            "snippet": (r.get("content") or r.get("snippet") or "")[:600],
        })
    # de-dup by URL
    seen = set()
    dedup = []
    for r in out:
        if r["url"] in seen:
            continue
        seen.add(r["url"])
        dedup.append(r)
    return dedup

# Nodes (plain funcitons)

def classify_claim(state: AgentState) -> AgentState:
    import logging
    logger = logging.getLogger(__name__)

    text = state["input_text"]
    logger.info(f"Classifying claim: '{text}'")

    prompt = (
        "Task: Determine if the text contains ANY fact-checkable claim, even if mixed with opinions or fragments.\n\n"
        "Look for assertions about:\n"
        "- Health/medical facts (e.g., 'Tylenol is not good', 'X increases autism risk')\n"
        "- Government/policy actions (e.g., 'FDA announced...', 'President said...')\n"
        "- Scientific facts (e.g., 'water on Mars', 'climate change causes...')\n"
        "- Historical events or statistics\n"
        "- Any other verifiable fact about the world\n\n"
        "Be LENIENT with transcription fragments - extract the core claim even if incomplete.\n\n"
        "CLAIMS (fact-checkable):\n"
        "✓ 'The FDA announced new guidelines'\n"
        "✓ 'Tylenol is not good' (health claim)\n"
        "✓ 'increase risk of autism. So taking Tylenol not good' (fragments but contains checkable claim)\n"
        "✓ 'Effective immediately the FDA will be notifying physicians' (policy claim)\n\n"
        "NOT CLAIMS (pure filler with no factual assertions):\n"
        "✗ 'Let me see how we say that'\n"
        "✗ 'Is that okay?'\n"
        "✗ 'I said it as well'\n"
        "✗ 'Alright, uh, so...'\n\n"
        "Return JSON with keys: is_claim (true/false), reason (string <= 200 chars).\n\n"
        f"Text:\n```{text}```"
    )
    raw = gemini_json(GEMINI_CLASSIFY_MODEL, prompt, temperature=0.1)
    logger.info(f"Gemini classification response: {raw}")

    try:
        judged = ClaimJudge(**raw)
    except ValidationError as e:
        raise RuntimeError(f"classify_claim JSON failed validation: {e}")

    state["is_claim"] = bool(judged.is_claim)
    state["claim_reason"] = judged.reason

    logger.info(f"Is claim: {judged.is_claim}, Reason: {judged.reason}")

    if not judged.is_claim:
        state["verdict"] = "not_a_claim"
        state["explanation"] = judged.reason
    return state

#Research node using Tavily
def research_with_tavily(state: AgentState) -> AgentState:
    query = state["input_text"]
    res = tavily.search(query=query, max_results=6)  # returns dict with 'results'
    normalized = normalize_research(res.get("results", []))
    state["research"] = normalized
    return state

def assess_claim(state: AgentState) -> AgentState:
    research_json = json.dumps(state.get("research", []), ensure_ascii=False)
    prompt = (
        "You are a concise fact-checker. Using ONLY the provided research, decide if the claim is "
        "'true', 'false', or 'unsubstantiated'.\n"
        "Return JSON: {verdict, explanation (<=600 chars), citations (array of {title,url} from the research only)}.\n\n"
        f"Claim:\n```{state['input_text']}```\n\n"
        f"Research JSON:\n{research_json}"
    )
    raw = gemini_json(GEMINI_ASSESS_MODEL, prompt, temperature=0.2)
    try:
        verdict = VerdictOut(**raw)
    except ValidationError as e:
        raise RuntimeError(f"assess_claim JSON failed validation: {e}")

    state["verdict"] = verdict.verdict
    state["explanation"] = verdict.explanation
    state["citations"] = verdict.citations or [
        {"title": r.get("title",""), "url": r.get("url","")} for r in state.get("research", [])
    ]
    return state

#finalize node
def finalize(state: AgentState) -> AgentState:
    return state


# Assemble the graph
# ──────────────────────────────────────────────────────────────────────────────
# Assemble the graph (FIXED)
# ──────────────────────────────────────────────────────────────────────────────
builder = StateGraph(AgentState)

# Add only your real nodes (NOT START/END)
builder.add_node("classify_claim", classify_claim)
builder.add_node("research_with_tavily", research_with_tavily)
builder.add_node("assess_claim", assess_claim)
builder.add_node("finalize", finalize)

# Entry: START → classify_claim   (don't add START as a node)
builder.add_edge(START, "classify_claim")

# Route out of classify_claim
def route_from_classify(state: AgentState) -> str:
    return "research_with_tavily" if state.get("is_claim") else "finalize"

builder.add_conditional_edges(
    "classify_claim",
    route_from_classify,
    {
        "research_with_tavily": "research_with_tavily",
        "finalize": "finalize",
    },
)

# Linear tail
builder.add_edge("research_with_tavily", "assess_claim")
builder.add_edge("assess_claim", "finalize")
builder.add_edge("finalize", END)

# Compile ONCE (after all nodes/edges)
memory = MemorySaver()  # optional
GRAPH = builder.compile(checkpointer=memory)

# Opik tracer (optional)
tracer = OpikTracer(graph=GRAPH.get_graph(xray=True))

# ──────────────────────────────────────────────────────────────────────────────
# Convenience function to run the agent
# ──────────────────────────────────────────────────────────────────────────────
def run_agent(text: str, thread_id: str = "session") -> Dict[str, Any]:
    init_state: AgentState = {"input_text": text}
    final_state = GRAPH.invoke(
        init_state,
        config={
            "callbacks": [tracer],                # optional tracing
            "configurable": {"thread_id": thread_id},  # needed if using checkpointer
        },
    )
    if final_state.get("verdict") == "not_a_claim":
        return {
            "status": "not_a_claim",
            "reason": final_state.get("explanation"),
        }
    return {
        "status": "fact_checked",
        "verdict": final_state.get("verdict"),
        "explanation": final_state.get("explanation"),
        "citations": final_state.get("citations"),
    }

if __name__ == "__main__":
    demo = run_agent("The Eiffel Tower is taller than 400 meters.")
    print(json.dumps(demo, indent=2))
