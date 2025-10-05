#!/usr/bin/env python3
"""
Simple Flask server that exposes a single endpoint to receive transcribed text
and run it through the langChainAgent fact-checking pipeline.
"""

import os
import json
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# Import the agent logic
from langChainAgent import run_agent

app = Flask(__name__)
CORS(app)  # Enable CORS for Electron app

@app.route('/transcribe', methods=['POST'])
def transcribe():
    """
    Single endpoint to receive transcribed text and return fact-check results.

    Expected JSON body:
    {
        "text": "The text to fact-check",
        "thread_id": "optional-session-id"  // defaults to "session"
    }

    Returns:
    {
        "status": "fact_checked" | "not_a_claim",
        "verdict": "true" | "false" | "unsubstantiated",  // only if status is fact_checked
        "explanation": "...",
        "citations": [...]  // only if status is fact_checked
    }
    """
    try:
        data = request.get_json()
        logger.info(f"Received request: {data}")

        if not data or 'text' not in data:
            logger.error("Missing 'text' field in request body")
            return jsonify({"error": "Missing 'text' field in request body"}), 400

        text = data['text']
        thread_id = data.get('thread_id', 'session')

        logger.info(f"Processing text: '{text}' (thread_id: {thread_id})")

        # Run the agent
        result = run_agent(text, thread_id=thread_id)

        logger.info(f"Agent result: {json.dumps(result, indent=2)}")

        return jsonify(result), 200

    except Exception as e:
        logger.exception(f"Error processing request: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok"}), 200

if __name__ == '__main__':
    port = int(os.getenv('PORT', 8080))
    app.run(host='0.0.0.0', port=port, debug=True)
