"""The Discord connection: py-cord's gateway client, running as a task on the
API's event loop.

Only DMs are handled. Task lists are personal, so nothing is ever posted in a
shared channel, and DMs carry message content without the privileged
Message Content intent. Each DM is answered for the Arturo account with the
author's Discord id; there is no other way to pick an account, and people
who have never signed in on the dashboard are told to do that first."""
import asyncio
import contextlib
import logging
import os

import anthropic
import discord

from ..db import MAX_BOT_MESSAGES_PER_DAY, get_conn
from .agent import APP_URL, FALLBACK_REPLY, messages_today, respond

log = logging.getLogger("arturo.bot")

# Discord's limit for one message from a bot; also caps what one DM can feed
# the model.
DISCORD_MAX_CHARS = 2000


def _find_user(discord_id: str) -> dict | None:
    conn = get_conn()
    try:
        row = conn.execute("SELECT id, discord_id FROM users WHERE discord_id = ?", (discord_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def split_message(text: str, limit: int = DISCORD_MAX_CHARS) -> list[str]:
    """Break a reply into Discord-sized pieces, preferring line breaks."""
    chunks = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        if cut <= 0:
            cut = limit
        chunks.append(text[:cut])
        text = text[cut:].lstrip("\n")
    if text:
        chunks.append(text)
    return chunks


class ArturoBot(discord.Client):
    def __init__(self, llm: anthropic.AsyncAnthropic):
        super().__init__(intents=discord.Intents.default())
        self.llm = llm
        # One turn at a time per person, so a quick second message sees the
        # first one's reply in its history and their writes don't interleave.
        self._locks: dict[int, asyncio.Lock] = {}

    async def on_ready(self):
        log.info("discord bot signed in as %s", self.user)

    async def on_message(self, message: discord.Message):
        if message.author.bot or message.guild is not None:
            return
        try:
            await self._handle(message)
        except Exception:
            log.exception("discord bot failed to answer a DM")
            try:
                await message.channel.send(FALLBACK_REPLY)
            except discord.DiscordException:
                pass

    async def _handle(self, message: discord.Message):
        user = await asyncio.to_thread(_find_user, str(message.author.id))
        if user is None:
            await message.channel.send(f"hey i don't know u yet, sign in at {APP_URL} with this discord account and then text me again")
            return
        text = message.content.strip()
        if not text:
            await message.channel.send("i can only read text rn, no attachments")
            return
        text = text[:DISCORD_MAX_CHARS]

        lock = self._locks.setdefault(user["id"], asyncio.Lock())
        async with lock:
            if await asyncio.to_thread(messages_today, user["id"]) >= MAX_BOT_MESSAGES_PER_DAY:
                await message.channel.send(
                    f"ok u hit today's limit of {MAX_BOT_MESSAGES_PER_DAY} messages, it resets at 4am eastern. "
                    f"the dashboard still works tho: {APP_URL}"
                )
                return
            # Start the typing indicator without waiting for it: entering
            # channel.typing() blocks on Discord's reply first. It is awaited
            # before sending because a late indicator would linger after the
            # reply (Discord clears it only when a message is sent).
            typing = asyncio.create_task(message.channel.trigger_typing())
            try:
                reply = await respond(self.llm, user, str(message.id), text)
            finally:
                with contextlib.suppress(discord.DiscordException):
                    await typing
            for chunk in split_message(reply):
                await message.channel.send(chunk)


def _log_exit(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    if task.exception() is not None:
        log.error("discord bot stopped", exc_info=task.exception())


async def start_bot() -> ArturoBot | None:
    """Connect the bot in the background, or skip it when it isn't
    configured. A bad token is logged, never raised: the API must come up
    either way, or a deploy would roll back over a Discord problem."""
    token = os.environ.get("DISCORD_BOT_TOKEN", "")
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not token or not api_key:
        log.info("discord bot disabled: DISCORD_BOT_TOKEN or ANTHROPIC_API_KEY is not set")
        return None
    bot = ArturoBot(anthropic.AsyncAnthropic(api_key=api_key))
    bot.runner = asyncio.create_task(bot.start(token), name="discord-bot")
    bot.runner.add_done_callback(_log_exit)
    return bot


async def stop_bot(bot: ArturoBot | None) -> None:
    if bot is None:
        return
    # Cancel the gateway task first: closing under it makes py-cord try to
    # reconnect on a closed HTTP session and fail loudly on every shutdown.
    bot.runner.cancel()
    await bot.close()
    await bot.llm.close()
