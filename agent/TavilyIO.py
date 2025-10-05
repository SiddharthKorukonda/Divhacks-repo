import os
import sys
import json
import time
import shlex
import logging
from dataclasses import dataclass, asdict
from typing import List, Optional, Dict, Any

# Optional imports
try:
    import google.generativeai as genai
    from google.generativeai import types as gen_types
except Exception:
    genai = None
    gen_types = None

try:
    import requests
except Exception:
    requests = None

# MCP client (optional)
try:
    from mcp.client.session import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client
    from mcp.types import TextContent
except Exception:
    ClientSession = None
    StdioServerParameters = None
    stdio_client = None
    TextContent = None

# ---------- Logging ----------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("factcheck")


# ---------- Data Models ----------
@dataclass
class Claim:
    id: str
    text: str
    topic: Optional[str] = None
    time_context: Optional[str] = None


@dataclass
class SearchResult:
    title: str
    url: str
    content: Optional[str] = None


@dataclass
class Verdict:
    claim_id: str
    label: str
    confidence: int
    rationale: str
    citations: List[Dict[str, Any]]


@dataclass
class FactCheckReport:
    claims: List[Claim]
    evidence: Dict[str, List[SearchResult]]
    verdicts: List[Verdict]


# ---------- Gemini Helpers ----------
def _ensure_gemini():
    if genai is None:
        raise RuntimeError("google-generativeai is not installed. Run: pip install google-generativeai")
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is not set in the environment.")
    genai.configure(api_key=api_key)


def gemini_model(model_name: str = "gemini-1.5-pro"):
    _ensure_gemini()
    return genai.GenerativeModel(model_name)


def extract_claims_with_gemini(text: str, max_claims: int = 10) -> List[Claim]:
    """
    Extract concise, checkable claims from text using Gemini.
    """
    model = gemini_model("gemini-1.5-pro")
    system_prompt = (
        "You are a claim extraction assistant. "
        "Extract concise, checkable factual claims from the provided text. "
        "Return JSON ONLY with schema:\n"
        '{ "claims": [ { "id": "c1", "text": "...", "topic": "general|news|science|finance|other", "time_context": "YYYY-MM-DD or null" } ] }\n'
        "Rules:\n"
        "- Each claim MUST be atomic.\n"
        "- Omit opinions.\n"
        "- Infer a reasonable time_context if clear; else null.\n"
        "- Limit to max_claims."
    )
    user_prompt = f"max_claims={max_claims}\nTEXT:\n{text}"
    gen_cfg = dict(temperature=0.1)
    resp = model.generate_content(
        [system_prompt, user_prompt],
        generation_config=gen_types.GenerationConfig(response_mime_type="application/json", **gen_cfg) if gen_types else None,
    )
    try:
        data = json.loads(resp.text)
        raw = data.get("claims", [])
    except Exception:
        logger.error("Gemini did not return valid JSON. Raw:\n%s", resp.text)
        return []

    claims: List[Claim] = []
    seen = set()
    for i, c in enumerate(raw[:max_claims], start=1):
        cid = str(c.get("id") or f"c{i}")
        if cid in seen:
            cid = f"c{i}"
        seen.add(cid)
        claims.append(Claim(
            id=cid,
            text=(c.get("text") or "").strip(),
            topic=c.get("topic") or None,
            time_context=c.get("time_context") or None,
        ))
    return claims


def build_fact_question(claim: Claim) -> str:
    t = f" as of {claim.time_context}" if claim.time_context else ""
    return f'Is the following statement true{t}: "{claim.text}"?'


def gemini_verdict_from_evidence(claim: Claim, sources: List[SearchResult]) -> Verdict:
    """
    Ask Gemini to judge the claim using only provided sources.
    """
    model = gemini_model("gemini-1.5-pro")
    evidence_blocks = []
    for s in sources[:10]:
        snippet = (s.content or "")[:1200]
        evidence_blocks.append({"title": s.title, "url": s.url, "content": snippet})

    system_prompt = (
        "You are a strict fact-checking judge. Use ONLY the provided sources.\n"
        "Output strictly JSON with schema:\n"
        '{ "label": "Supported|Refuted|Uncertain", "confidence": 1-5, '
        '"rationale": "short text", "citations": [ {"url": "...", "title": "...", "quote": "exact quoted span"} ] }'
    )
    user_payload = {"claim": asdict(claim), "evidence": evidence_blocks}
    gen_cfg = dict(temperature=0.1)
    resp = model.generate_content(
        [system_prompt, json.dumps(user_payload, ensure_ascii=False)],
        generation_config=gen_types.GenerationConfig(response_mime_type="application/json", **gen_cfg) if gen_types else None,
    )

    label = "Uncertain"
    confidence = 2
    rationale = "Insufficient data."
    citations = []
    try:
        data = json.loads(resp.text)
        label = data.get("label", label)
        confidence = int(data.get("confidence", confidence))
        rationale = data.get("rationale", rationale)
        citations = data.get("citations", citations)
    except Exception:
        logger.warning("Gemini verdict parsing failed; defaulting to Uncertain. Raw:\n%s", resp.text)

    return Verdict(
        claim_id=claim.id,
        label=label,
        confidence=confidence,
        rationale=rationale,
        citations=citations,
    )


# ---------- Tavily via MCP + REST fallback ----------
class TavilyClient:
    """
    Prefer MCP (Model Context Protocol) server. If not available, use REST fallback.
    """
    def __init__(self, topic: str = "general"):
        self.topic = topic
        self.mcp_cmd = os.getenv("TAVILY_MCP_CMD")
        self.mcp_args = shlex.split(os.getenv("TAVILY_MCP_ARGS", "")) if os.getenv("TAVILY_MCP_ARGS") else []
        self.tavily_api_key = os.getenv("TAVILY_API_KEY")
        self.rest_endpoint = "https://api.tavily.com/search"

    def _mcp_available(self) -> bool:
        return (ClientSession is not None) and (StdioServerParameters is not None) and (stdio_client is not None) and bool(self.mcp_cmd)

    async def _mcp_search(self, query: str, *, max_results: int = 10, search_depth: str = "basic",
                          include_raw_content: str = "markdown",
                          days: Optional[int] = None, start_date: Optional[str] = None, end_date: Optional[str] = None,
                          include_domains: Optional[List[str]] = None, exclude_domains: Optional[List[str]] = None) -> List[SearchResult]:
        params = {
            "query": query,
            "topic": self.topic,
            "max_results": max_results,
            "search_depth": search_depth,
            "include_raw_content": include_raw_content,
        }
        if days is not None:
            params["days"] = days
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        if include_domains:
            params["include_domains"] = include_domains
        if exclude_domains:
            params["exclude_domains"] = exclude_domains

        results: List[SearchResult] = []
        server = StdioServerParameters(command=self.mcp_cmd, args=self.mcp_args)

        async with stdio_client(server) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = await session.list_tools()
                tool_name = None
                for t in tools.tools:
                    # common names: "tavily.search", "search", or "tavily"
                    if t.name.lower() in ("tavily.search", "search", "tavily"):
                        tool_name = t.name
                        break
                if not tool_name:
                    raise RuntimeError("No Tavily MCP tool found. Available: " + ", ".join([t.name for t in tools.tools]))

                call = await session.call_tool(tool_name, arguments=params)
                # Expect the server to return a JSON blob (possibly as text content)
                for item in call.content:
                    if isinstance(item, TextContent):
                        try:
                            payload = json.loads(item.text)
                        except Exception:
                            payload = None
                        if isinstance(payload, dict) and "results" in payload:
                            for r in payload["results"][:max_results]:
                                results.append(SearchResult(
                                    title=r.get("title", "untitled"),
                                    url=r.get("url", ""),
                                    content=r.get("content") or r.get("raw_content") or r.get("snippet") or None,
                                ))
        return results

    def _rest_search(self, query: str, *, max_results: int = 10, search_depth: str = "basic",
                     include_raw_content: str = "markdown",
                     days: Optional[int] = None, start_date: Optional[str] = None, end_date: Optional[str] = None,
                     include_domains: Optional[List[str]] = None, exclude_domains: Optional[List[str]] = None) -> List[SearchResult]:
        if requests is None:
            raise RuntimeError("requests is not installed. Run: pip install requests")
        if not self.tavily_api_key:
            raise RuntimeError("TAVILY_API_KEY not set; cannot use REST fallback.")

        payload = {
            "api_key": self.tavily_api_key,
            "query": query,
            "topic": self.topic,
            "max_results": max_results,
            "search_depth": search_depth,
            "include_raw_content": include_raw_content,
        }
        if days is not None:
            payload["days"] = days
        if start_date:
            payload["start_date"] = start_date
        if end_date:
            payload["end_date"] = end_date
        if include_domains:
            payload["include_domains"] = include_domains
        if exclude_domains:
            payload["exclude_domains"] = exclude_domains

        resp = requests.post(self.rest_endpoint, json=payload, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        results: List[SearchResult] = []
        for r in data.get("results", [])[:max_results]:
            results.append(SearchResult(
                title=r.get("title", "untitled"),
                url=r.get("url", ""),
                content=r.get("content") or r.get("raw_content") or r.get("snippet") or None,
            ))
        return results

    def search(self, query: str, **kwargs) -> List[SearchResult]:
        if self._mcp_available():
            try:
                import asyncio
                return asyncio.run(self._mcp_search(query, **kwargs))
            except Exception as e:
                logger.warning("MCP search failed: %s. Falling back to REST if available.", e)
        return self._rest_search(query, **kwargs)


# ---------- Orchestration ----------
def retrieve_evidence_for_claims(claims: List[Claim], *, topic: str = "general",
                                 search_depth: str = "basic", max_results: int = 10,
                                 include_raw_content: str = "markdown",
                                 days: Optional[int] = None, start_date: Optional[str] = None, end_date: Optional[str] = None,
                                 include_domains: Optional[List[str]] = None, exclude_domains: Optional[List[str]] = None) -> Dict[str, List[SearchResult]]:
    client = TavilyClient(topic=topic)
    evidence: Dict[str, List[SearchResult]] = {}
    for claim in claims:
        q = build_fact_question(claim)
        logger.info("Tavily searching for %s: %s", claim.id, q)
        hits = client.search(
            q,
            max_results=max_results,
            search_depth=search_depth,
            include_raw_content=include_raw_content,
            days=days,
            start_date=start_date,
            end_date=end_date,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
        )
        evidence[claim.id] = hits
        time.sleep(0.25)
    return evidence


def adjudicate_claims_with_gemini(claims: List[Claim], evidence: Dict[str, List[SearchResult]]) -> List[Verdict]:
    out: List[Verdict] = []
    for claim in claims:
        sources = evidence.get(claim.id, [])
        logger.info("Adjudicating %s with %d sources", claim.id, len(sources))
        out.append(gemini_verdict_from_evidence(claim, sources))
    return out


def run_factcheck_pipeline_from_text(text: str, *, topic: str = "general", max_claims: int = 10,
                                     search_depth: str = "basic", max_results: int = 10,
                                     include_raw_content: str = "markdown",
                                     days: Optional[int] = None, start_date: Optional[str] = None, end_date: Optional[str] = None,
                                     include_domains: Optional[List[str]] = None, exclude_domains: Optional[List[str]] = None) -> FactCheckReport:
    claims = extract_claims_with_gemini(text, max_claims=max_claims)
    evidence = retrieve_evidence_for_claims(
        claims,
        topic=topic,
        search_depth=search_depth,
        max_results=max_results,
        include_raw_content=include_raw_content,
        days=days,
        start_date=start_date,
        end_date=end_date,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
    )
    verdicts = adjudicate_claims_with_gemini(claims, evidence)
    return FactCheckReport(claims=claims, evidence=evidence, verdicts=verdicts)


# ---------- CLI (optional for local testing) ----------
def _load_text_from_file(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _serialize_report(report: FactCheckReport) -> Dict[str, Any]:
    return {
        "claims": [asdict(c) for c in report.claims],
        "evidence": {cid: [asdict(sr) for sr in srs] for cid, srs in report.evidence.items()},
        "verdicts": [asdict(v) for v in report.verdicts],
    }


def main(argv: List[str]) -> int:
    import argparse

    g = argparse.ArgumentParser(description="Gemini + Tavily fact-check pipeline (MCP preferred).")
    src = g.add_mutually_exclusive_group(required=True)
    src.add_argument("--text", type=str, help="Raw text to extract claims from")
    src.add_argument("--file", type=str, help="Path to a text file to read")

    g.add_argument("--topic", default="general", help="Tavily topic: general|news|finance|science|other")
    g.add_argument("--max-claims", type=int, default=10)
    g.add_argument("--search-depth", choices=["basic", "advanced"], default="basic")
    g.add_argument("--max-results", type=int, default=10)
    g.add_argument("--days", type=int, default=None, help="Use for recent window when topic=news")
    g.add_argument("--start-date", type=str, default=None)
    g.add_argument("--end-date", type=str, default=None)
    g.add_argument("--include-domains", type=str, default=None, help="Comma-separated allowlist")
    g.add_argument("--exclude-domains", type=str, default=None, help="Comma-separated blocklist")
    g.add_argument("--out", type=str, default=None, help="Optional output JSON path")

    args = g.parse_args(argv)

    text = args.text if args.text else _load_text_from_file(args.file)
    include_domains = args.include_domains.split(",") if args.include_domains else None
    exclude_domains = args.exclude_domains.split(",") if args.exclude_domains else None

    report = run_factcheck_pipeline_from_text(
        text,
        topic=args.topic,
        max_claims=args.max_claims,
        search_depth=args.search_depth,
        max_results=args.max_results,
        include_raw_content="markdown",
        days=args.days,
        start_date=args.start_date,
        end_date=args.end_date,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
    )

    payload = _serialize_report(report)
    pretty = json.dumps(payload, ensure_ascii=False, indent=2)
    print(pretty)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(pretty)
        logger.info("Wrote report to %s", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
