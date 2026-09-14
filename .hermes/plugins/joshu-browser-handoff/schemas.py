"""Tool schemas for owner mobile browser handoff."""

BROWSER_HANDOFF_REQUEST_SCHEMA = {
    "name": "browser_handoff_request",
    "description": (
        "Hand the shared Camofox tab to the owner on mobile for live HITL — payment, login, 2FA, "
        "irreversible confirms, or any sensitive owner-only browser step. Snapshots current page URL/title, "
        "returns a signed handoff URL for email/chat. Agent navigate/click/type is blocked until the owner "
        "taps I'm done or the handoff expires. Call after staging the page the owner should see."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "instructions": {
                "type": "string",
                "description": (
                    "Concise owner brief: site, what to verify, what action to take, policy caps "
                    "(price, dates, cancellation, refund amount, etc.)."
                ),
            },
            "kanban_task_id": {
                "type": "string",
                "description": "Optional Kanban task id for correlation while awaiting owner completion.",
            },
        },
        "required": ["instructions"],
    },
}

BROWSER_HANDOFF_STATUS_SCHEMA = {
    "name": "browser_handoff_status",
    "description": (
        "Poll owner mobile browser handoff status (pending, completed, expired, cancelled). "
        "After completed, browser_snapshot to verify outcome before kanban_complete."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "handoff_id": {
                "type": "string",
                "description": "Handoff id returned by browser_handoff_request.",
            },
        },
        "required": ["handoff_id"],
    },
}
