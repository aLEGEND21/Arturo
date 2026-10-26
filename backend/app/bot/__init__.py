"""The Discord bot. People DM it in plain language; Claude turns each message
into calls to a few task tools (tools.py) that act only on the sender's own
data. It runs inside the API process, started from main.py's lifespan, so
SQLite keeps a single owning process."""
