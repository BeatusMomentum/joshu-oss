BROWSER_TASK_SCHEMA = {
    "name": "browser_task",
    "description": (
        "Run a web task on the shared Chromium tab via the browser-use Agent. "
        "One task at a time. Stop before payment, a CAPTCHA, or typing secrets, "
        "then call browser_handoff_request. Refused while a handoff is pending."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "task": {
                "type": "string",
                "description": "What to do on the current page, in plain language.",
            }
        },
        "required": ["task"],
    },
}
