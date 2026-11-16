"""Who may call and how much: allowed origins, the visitor's address, per-minute limits, the spend cap and alerts.

Every count lives in this process's memory: it starts at zero when the server starts, and two processes (or two
machines behind a load balancer) each count on their own. For more than one process, keep the counts in a shared
store such as Redis, with the same rules."""
import asyncio, collections, math, os, time, urllib.parse

import labs

PORT = int(os.environ.get("PORT") or 8040)
ORIGINS = {o.strip().rstrip("/") for o in (os.environ.get("ALLOWED_ORIGINS")
                                          or f"http://localhost:{PORT},http://127.0.0.1:{PORT}").split(",") if o.strip()}
TRUST_PROXY = os.environ.get("TRUST_PROXY") == "1"


def origin_of(headers):
    """The page's origin: Origin, or the origin of Referer when there is none (an <audio> element sends no Origin)."""
    if headers.get("Origin"):
        return headers["Origin"].rstrip("/")
    ref = urllib.parse.urlsplit(headers.get("Referer", ""))
    return f"{ref.scheme}://{ref.netloc}" if ref.scheme and ref.netloc else None


def allowed_origin(headers):
    origin = origin_of(headers)
    return origin if origin in ORIGINS else None


def visitor(request):
    """The visitor's address. Behind your own proxy (TRUST_PROXY=1) it is the last X-Forwarded-For entry, the one
    your proxy added; without a proxy that header is whatever the visitor sent, so it is ignored."""
    if TRUST_PROXY and request.headers.get("X-Forwarded-For"):
        return request.headers["X-Forwarded-For"].split(",")[-1].strip()
    return request.remote or "-"


class Limits:
    """Per-minute limits, per visitor and for the whole site, as a sliding 60-second window."""

    def __init__(self, per_visitor, per_site):
        self.per_visitor, self.per_site = per_visitor, per_site  # {bucket: count a minute}
        self.seen = collections.defaultdict(collections.deque)  # (bucket, who) -> times of recent calls

    def take(self, bucket, who):
        """Counts one call. Returns 0 if it may go ahead, else the seconds until it may."""
        now, waits = time.monotonic(), []
        for key, limit in (((bucket, who), self.per_visitor[bucket]), ((bucket, "*site*"), self.per_site.get(bucket))):
            q = self.seen[key]
            while q and q[0] <= now - 60:
                q.popleft()
            if limit is not None and len(q) >= limit:
                waits.append(math.ceil(q[0] + 60 - now))
        if waits:
            return max(waits)
        self.seen[(bucket, who)].append(now)
        self.seen[(bucket, "*site*")].append(now)
        return 0


class Budget:
    """The owner's spend cap: `monthlyCredits` for the site in a calendar month, `perVisitorCredits` for each
    visitor in a day. Credits are counted from X-Credits-Charged on every Labs answer."""

    def __init__(self, monthly, per_visitor):
        self.monthly, self.per_visitor = monthly, per_visitor
        self.month, self.month_spent = time.strftime("%Y-%m"), 0
        self.visitors = collections.defaultdict(collections.deque)  # who -> (time, credits) in the last day

    def _visitor_spent(self, who):
        q = self.visitors[who]
        while q and q[0][0] <= time.time() - 86400:
            q.popleft()
        return sum(c for _, c in q)

    def allows(self, who):
        if time.strftime("%Y-%m") != self.month:
            self.month, self.month_spent = time.strftime("%Y-%m"), 0
        if self.month_spent >= self.monthly:
            alert("budget", f"the month's budget of {self.monthly} credits is spent: the assistant is refusing questions")
            return False
        return self._visitor_spent(who) < self.per_visitor

    def spend(self, who, credits):
        if credits:
            self.month_spent += credits
            self.visitors[who].append((time.time(), credits))


ALERT_EVERY = 3600  # seconds: during an outage every visitor fails the same way, so one alert per kind an hour
last_alert = {}
alert_to = {"how": "email", "who": [], "webhookUrl": ""}  # server.py fills this from `alerts` in the answers


def alert(kind, text):
    """Tells the owner, at most once an hour per kind: posts {"text": ...} to the webhook, or logs who to email."""
    if time.time() - last_alert.get(kind, 0) < ALERT_EVERY:
        return
    last_alert[kind] = time.time()
    url = os.environ.get("ALERT_WEBHOOK_URL") or alert_to.get("webhookUrl")
    if alert_to.get("how") == "webhook" and url:
        asyncio.ensure_future(post_alert(url, text))
    else:
        print(f"[alert] for {', '.join(alert_to.get('who') or ['the owner'])} ({alert_to.get('how')}): Site assistant: {text}")


async def post_alert(url, text):
    try:
        async with labs.http.post(url, json={"text": f"Site assistant: {text}"}, headers={"User-Agent": labs.UA}) as r:
            status = r.status
    except Exception as e:  # an alert must never break a visitor's request
        status = type(e).__name__
    print(f"[alert] POST {urllib.parse.urlsplit(url).hostname} -> {status}")
