#!/usr/bin/env python3
"""
last30days PWA server.

Serves the web frontend and exposes the research API.

Usage:
    python3 server.py [--port=8080] [--host=0.0.0.0]
"""

import argparse
import importlib.util
import json
import os
import sys
import traceback
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

# Add scripts to path so we can import the lib modules
SCRIPT_DIR = Path(__file__).parent.resolve() / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from lib import dates, dedupe, env, models, normalize, schema, score

# Import last30days.py as a module (it's a script, not a package)
_spec = importlib.util.spec_from_file_location("last30days", SCRIPT_DIR / "last30days.py")
_last30days = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_last30days)
run_research = _last30days.run_research
load_fixture = _last30days.load_fixture

app = Flask(__name__, static_folder="web", static_url_path="")


# --- Static file serving ---

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/manifest.json")
def manifest():
    return send_from_directory(app.static_folder, "manifest.json")


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory(app.static_folder, "sw.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


# --- API endpoints ---

@app.route("/api/status")
def api_status():
    """Return current configuration status (which sources are available)."""
    config = env.get_config()
    available = env.get_available_sources(config)
    x_source_status = env.get_x_source_status(config)

    if x_source_status["source"] == "bird":
        if available == "reddit":
            available = "both"
        elif available == "web":
            available = "x"

    return jsonify({
        "available_sources": available,
        "has_openai": bool(config.get("OPENAI_API_KEY")),
        "has_xai": bool(config.get("XAI_API_KEY")),
        "x_source": x_source_status["source"],
        "bird_installed": x_source_status["bird_installed"],
        "bird_authenticated": x_source_status["bird_authenticated"],
    })


@app.route("/api/search", methods=["POST"])
def api_search():
    """Run research and return results as JSON."""
    data = request.get_json()
    if not data or not data.get("topic"):
        return jsonify({"error": "Topic is required"}), 400

    topic = data["topic"]
    sources = data.get("sources", "auto")
    depth = data.get("depth", "default")
    days = data.get("days", 30)
    mock = data.get("mock", False)

    days = max(1, min(30, int(days)))

    try:
        config = env.get_config()
        x_source_status = env.get_x_source_status(config)
        x_source = x_source_status["source"]

        available = env.get_available_sources(config)
        if x_source == "bird":
            if available == "reddit":
                available = "both"
            elif available == "web":
                available = "x"

        if mock:
            effective_sources = "both" if sources == "auto" else sources
        else:
            effective_sources, error = env.validate_sources(sources, available)
            if error and "WebSearch fallback" not in error:
                return jsonify({"error": error}), 400
            if effective_sources is None:
                effective_sources = "web"

        from_date, to_date = dates.get_date_range(days)

        if mock:
            selected_models = models.get_models(
                {"OPENAI_API_KEY": "mock", "XAI_API_KEY": "mock", **config},
                load_fixture("models_openai_sample.json").get("data", []),
                load_fixture("models_xai_sample.json").get("data", []),
            )
        else:
            selected_models = models.get_models(config)

        reddit_items, x_items, web_needed, raw_openai, raw_xai, raw_reddit_enriched, reddit_error, x_error = run_research(
            topic, effective_sources, config, selected_models,
            from_date, to_date, depth, mock,
            x_source=x_source or "xai",
        )

        # Process results
        normalized_reddit = normalize.normalize_reddit_items(reddit_items, from_date, to_date)
        normalized_x = normalize.normalize_x_items(x_items, from_date, to_date)

        filtered_reddit = normalize.filter_by_date_range(normalized_reddit, from_date, to_date)
        filtered_x = normalize.filter_by_date_range(normalized_x, from_date, to_date)

        scored_reddit = score.score_reddit_items(filtered_reddit)
        scored_x = score.score_x_items(filtered_x)

        sorted_reddit = score.sort_items(scored_reddit)
        sorted_x = score.sort_items(scored_x)

        deduped_reddit = dedupe.dedupe_reddit(sorted_reddit)
        deduped_x = dedupe.dedupe_x(sorted_x)

        if not deduped_reddit and normalized_reddit:
            by_relevance = sorted(normalized_reddit, key=lambda item: item.relevance, reverse=True)
            deduped_reddit = by_relevance[:3]

        # Determine mode string
        mode_map = {
            "all": "all", "both": "both", "reddit": "reddit-only",
            "reddit-web": "reddit-web", "x": "x-only",
            "x-web": "x-web", "web": "web-only",
        }
        mode = mode_map.get(effective_sources, effective_sources)

        report = schema.create_report(
            topic, from_date, to_date, mode,
            selected_models.get("openai"),
            selected_models.get("xai"),
        )
        report.reddit = deduped_reddit
        report.x = deduped_x
        report.reddit_error = reddit_error
        report.x_error = x_error

        return jsonify(report.to_dict())

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="last30days PWA server")
    parser.add_argument("--port", type=int, default=8080, help="Port (default: 8080)")
    parser.add_argument("--host", default="0.0.0.0", help="Host (default: 0.0.0.0)")
    parser.add_argument("--debug", action="store_true", help="Debug mode")
    args = parser.parse_args()

    print(f"Starting last30days PWA on http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=args.debug)
