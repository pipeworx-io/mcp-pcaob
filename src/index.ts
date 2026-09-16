interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


// Reusable entity-resolution helpers for MCP packs. SELF-CONTAINED — no internal
// imports — so publish-pack.sh can inline it into standalone pack builds the same
// way it inlines the McpToolExport type.
//
// Recurring failure mode across financial packs: callers pass a company NAME
// ("Apple", "apple inc") where a ticker / CIK / provider symbol is expected, and
// the pack 404s or throws "not found". `rankMatches` is a generic name-ranker any
// pack can run over its OWN list (US tickers, B3 tickers, drug names, airports…);
// `resolveSecEntity` wraps it around the SEC company_tickers.json universe, shared
// by the packs that key on CIK (edgar, sec).

type MatchKind = 'exact' | 'prefix' | 'word' | 'substring';

interface RankedMatch<T> {
  item: T;
  kind: MatchKind;
  score: number;
}

const normalize = (s: string): string =>
  s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank `items` by how well their name matches `query`:
 * exact (4) > prefix (3) > whole-word (2) > substring (1). Ties break by shortest
 * name — the primary entity (e.g. "Apple Inc." over "Apple Hospitality REIT").
 * Returns only items that match at all, best first. Pure (no I/O).
 */
function rankMatches<T>(
  query: string,
  items: T[],
  getName: (item: T) => string,
): RankedMatch<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const scored: { item: T; kind: MatchKind; score: number; len: number }[] = [];
  for (const item of items) {
    const name = getName(item);
    const n = normalize(name);
    let kind: MatchKind | null = null;
    let score = 0;
    if (n === q) { kind = 'exact'; score = 4; }
    else if (n.startsWith(q)) { kind = 'prefix'; score = 3; }
    else if (n.includes(` ${q} `) || n.endsWith(` ${q}`)) { kind = 'word'; score = 2; }
    else if (n.includes(q)) { kind = 'substring'; score = 1; }
    if (kind) scored.push({ item, kind, score, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored.map(({ item, kind, score }) => ({ item, kind, score }));
}

interface SecTickerRow { cik_str: number; ticker: string; title: string }

interface SecEntity {
  ticker: string;
  cik: string;
  cik_padded: string;
  company_name: string;
  matched_by: 'ticker' | 'company_name';
  alternatives?: { ticker: string; company_name: string; cik: string }[];
}

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/**
 * Resolve a ticker OR company name to its SEC identity (CIK + canonical name).
 * Exact ticker first (the common, unambiguous case), then fuzzy company-name
 * fallback so "Apple" / "APPLE" → AAPL's CIK. Throws if nothing matches.
 *
 * `headers` lets callers pass their pack's SEC User-Agent — www.sec.gov requires
 * a UA. `fetchImpl` defaults to global fetch (override in tests).
 */
async function resolveSecEntity(
  query: string,
  opts: { fetchImpl?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<SecEntity> {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Required argument is missing or empty. Pass a ticker like "AAPL" or a company name like "Apple".');
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEC_TICKERS_URL, { headers: opts.headers });
  if (!res.ok) throw new Error(`SEC ticker lookup error: ${res.status}`);
  const data = (await res.json()) as Record<string, SecTickerRow>;
  const rows = Object.values(data);

  // 1) Exact ticker match — the common, unambiguous case.
  const q = query.toUpperCase().trim();
  for (const r of rows) {
    if (r.ticker === q) return toEntity(r, 'ticker');
  }

  // 2) Company-name fallback.
  const ranked = rankMatches(query, rows, (r) => r.title);
  if (ranked.length) {
    const best = toEntity(ranked[0].item, 'company_name');
    const alts = ranked.slice(1, 4).map((m) => ({
      ticker: m.item.ticker,
      company_name: m.item.title,
      cik: String(m.item.cik_str),
    }));
    if (alts.length) best.alternatives = alts;
    return best;
  }

  throw new Error(`No SEC company matches "${query}". Pass a US-listed ticker ("AAPL") or the exact listed-company name ("Apple Inc."). If this is a clinical-trial sponsor, an operating subsidiary (e.g. "Merck Sharp & Dohme" → Merck & Co), or a foreign/private entity, call sponsor_to_filer({sponsor}) instead — it resolves subsidiaries to the listed parent and honestly reports when no US-listed filer exists.`);
}

function toEntity(r: SecTickerRow, matched_by: 'ticker' | 'company_name'): SecEntity {
  return {
    ticker: r.ticker,
    cik: String(r.cik_str),
    cik_padded: String(r.cik_str).padStart(10, '0'),
    company_name: r.title,
    matched_by,
  };
}

const GENERIC_CORP_WORDS = new Set([
  'THE', 'A', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED',
  'LLC', 'LP', 'PLC', 'SA', 'AG', 'NV', 'GMBH', 'AB', 'AS', 'OY', 'SPA',
  'GROUP', 'HOLDINGS', 'HOLDING', 'AND', 'OF', 'US', 'USA', 'INTERNATIONAL',
  'GLOBAL',
]);

/**
 * Split a corporate/organization name into its SIGNIFICANT tokens — words
 * that aren't generic corporate boilerplate (Inc, Co, Ltd, Group, ...) or
 * punctuation — sorted LONGEST FIRST. Built for cross-registry name joins
 * where the two registries anchor on different words of the same name: SEC
 * lists Eli Lilly as "ELI LILLY & Co", but Drugs@FDA's sponsor_name field
 * uses "LILLY" — the longer, more distinctive token, not the first one
 * ("ELI" alone is short and matches too loosely). Pure (no I/O); callers
 * typically try tokens in order until one call to their OWN registry
 * returns a result.
 */
function significantNameTokens(name: string): string[] {
  const tokens = name
    .toUpperCase()
    .replace(/[.,&/()-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !GENERIC_CORP_WORDS.has(t));
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}
/**
 * PCAOB — Form AP auditor<->issuer engagements + firm inspection reports.
 * Fleet #624: "who audits Company X and which engagement partner signed",
 * "every issuer audited by Firm Y", "has PCAOB found deficiencies at Firm Y"
 * have no surface today.
 *
 * SOURCES (both mirrored by workers/data-pipeline, see
 * workers/data-pipeline/src/datasets/pcaob.ts for ingest details/traps):
 *  - pcaob_form_ap: PCAOB's own bulk download of the whole AuditorSearch
 *    dataset (assets.pcaobus.org/firm-filings/FirmFilings.zip), ~156k rows.
 *  - pcaob_inspection_reports: the Firm Inspection Reports downloadable
 *    dataset (JSON variant — see pcaob.ts for why not the CSV), ~4.3k rows,
 *    one per firm per inspection report.
 *
 * IDENTITY. Issuer CIK is SEC's, so a ticker/company-name input is resolved
 * through resolveSecEntity (shared/src/resolve.ts) — the same universe
 * `edgar` and `sec` key on. Not every Form AP issuer is a public operating
 * company (broker-dealers, closed-end funds, unit investment trusts can lack
 * a clean SEC ticker), so CIK resolution failure falls back to an issuer_name
 * search across Form AP filings rather than erroring out.
 *
 * FIRM IDENTITY. Firms have a PCAOB-assigned Firm ID; the same firm's name
 * varies by country affiliate ("PwC LLP" vs "PricewaterhouseCoopers LLP").
 * Search matches on firm_id when it looks like one (all-digits), ilike
 * otherwise, and every response echoes back the firm_id(s) it matched so a
 * caller can disambiguate.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'PCAOB');
}

interface Cfg { url: string; key: string }

const FORM_AP = 'pcaob_form_ap';
const INSPECTIONS = 'pcaob_inspection_reports';

const UA = 'pipeworx-mcp-pcaob/1.0 (+https://pipeworx.io)';

async function pg<T>(cfg: Cfg, table: string, query: string): Promise<T> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
  });
  if (!res.ok) throw new Error(`data query ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// PostgREST clamps every response to its db-max-rows server setting (1000)
// regardless of the `limit=` a query asks for — see sec-13f's pgAll comment
// for the measured failure this guards against. `query` must not include its
// own `limit=`; Range headers own paging here.
const PG_PAGE = 1000;
async function pgAll<T>(cfg: Cfg, table: string, query: string, maxRows = 10000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < maxRows; offset += PG_PAGE) {
    const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Range-Unit': 'items',
        Range: `${offset}-${offset + PG_PAGE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`data query ${table}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as T[];
    out.push(...page);
    if (page.length < PG_PAGE) break;
  }
  return out;
}

const esc = (s: string) => s.replace(/[(),*]/g, ' ').trim();
const isDigits = (s: string) => /^\d+$/.test(s.trim());

const CAVEAT =
  'PCAOB Form AP covers US issuer audits only (auditors of SEC-reporting companies), self-reported by the audit firm. Issuer CIK can be blank for non-SEC registrants (e.g. some broker-dealers); those rows are kept under issuer_name only. Firm inspection findings reflect Part I.A summary counts from PCAOB\'s published dataset, not the full report text.';

const tools: McpToolExport['tools'] = [
  {
    name: 'pcaob_auditor_of',
    description:
      'Which PCAOB-registered firm audits a company, and which engagement partner signed the most recent audit report — resolves a ticker or company name to SEC CIK first, then falls back to a name search in our own PCAOB Form AP index if the company has no clean SEC ticker (funds, broker-dealers). Returns firm name/id, engagement partner, audit report date and fiscal period end. Use for "who audits Apple", "Tesla\'s audit engagement partner".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company: { type: 'string', description: 'Ticker (e.g. "AAPL") or company/issuer name.' },
      },
      required: ['company'],
    },
  },
  {
    name: 'pcaob_firm_engagements',
    description:
      'Every issuer a PCAOB-registered audit firm reported auditing via Form AP, optionally scoped to one fiscal year. Give a firm name ("Ernst & Young", "Deloitte") or its numeric PCAOB Firm ID. Use for "every issuer audited by Deloitte in 2025", "how many public companies does BDO audit".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        firm: { type: 'string', description: 'Firm name (partial match ok) or numeric PCAOB Firm ID.' },
        fiscal_year: { type: 'number', description: 'Restrict to engagements whose fiscal period end falls in this year, e.g. 2025.' },
        limit: { type: 'number', description: 'Max issuers to return, 1-500 (default 100).' },
      },
      required: ['firm'],
    },
  },
  {
    name: 'pcaob_partner_engagements',
    description:
      'Every issuer a named engagement partner signed for, per Form AP. Give a last name (and optionally first name) — matches are partial. Use for "what companies has [partner name] audited".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        partner: { type: 'string', description: 'Engagement partner name — last name alone works, or "First Last".' },
        limit: { type: 'number', description: 'Max engagements to return, 1-200 (default 50).' },
      },
      required: ['partner'],
    },
  },
  {
    name: 'pcaob_auditor_changes',
    description:
      'Issuers whose most recent Form AP filing names a DIFFERENT audit firm than their prior filing, where the new filing landed in the last N days — the "who switched auditors recently" aggregation, which no upstream PCAOB page offers directly. Scans issuers with a Form AP filing in the window (capped at 1500 issuers per call) and compares each against its own filing history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Lookback window in days for the most recent filing (default 90).' },
        limit: { type: 'number', description: 'Max changes to return, 1-200 (default 50).' },
      },
    },
  },
  {
    name: 'pcaob_inspection_reports',
    description:
      'PCAOB inspection history for an audit firm: report year, Part I.A deficiency rate, audits reviewed, and a link to the PDF report. Give a firm name (partial match ok). Use for "has PCAOB found deficiencies at Deloitte", "KPMG PCAOB inspection history".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        firm: { type: 'string', description: 'Firm name, partial match ok, e.g. "Deloitte".' },
        limit: { type: 'number', description: 'Max reports to return, 1-100 (default 25).' },
      },
      required: ['firm'],
    },
  },
];

interface FormApRow {
  form_filing_id: number;
  firm_id: string | null;
  firm_name: string | null;
  firm_country: string | null;
  issuer_id: string | null;
  issuer_name: string | null;
  issuer_cik: string | null;
  audit_report_type: string | null;
  audit_report_date: string | null;
  fiscal_period_end_date: string | null;
  engagement_partner_first: string | null;
  engagement_partner_last: string | null;
  engagement_partner_id: string | null;
  num_participants: number | null;
  participant_percentage: string | null;
  filing_date: string | null;
}

interface InspectionRow {
  registration_id: number;
  inspection_report_date: string;
  firm_name: string | null;
  country: string | null;
  global_network: string | null;
  audits_with_deficiencies: number | null;
  total_audits_reviewed: number | null;
  deficiency_rate_pct: string | null;
  inspection_year: number | null;
  inspection_type: string | null;
  includes_qc_criticisms: boolean | null;
  pdf_report_url: string | null;
}

async function auditorOf(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.company ?? '').trim();
  if (!raw) throw new Error('user_error: `company` is required — a ticker or company/issuer name.');

  let cikPadded: string | null = null;
  let resolvedVia: { ticker: string; company_name: string; cik: string } | null = null;
  try {
    const ent = await resolveSecEntity(raw, { headers: { 'User-Agent': UA } });
    cikPadded = ent.cik_padded;
    resolvedVia = { ticker: ent.ticker, company_name: ent.company_name, cik: ent.cik_padded };
  } catch {
    // Not every Form AP issuer has a clean SEC ticker — fall through to a
    // name search across Form AP filings below.
  }

  let rows: FormApRow[] = [];
  let matchedOn: string;
  if (cikPadded) {
    rows = await pg<FormApRow[]>(
      cfg, FORM_AP,
      `select=*&issuer_cik=eq.${cikPadded}&order=audit_report_date.desc.nullslast&limit=1`,
    );
    matchedOn = 'sec_cik';
    if (!rows.length) {
      // CIK resolved but this issuer has never filed a Form AP under it —
      // fall back to name search rather than reporting "not found" on a
      // company that plainly resolved to something real.
      rows = await pg<FormApRow[]>(
        cfg, FORM_AP,
        `select=*&issuer_name=ilike.*${encodeURIComponent(esc(raw))}*&order=audit_report_date.desc.nullslast&limit=1`,
      );
      matchedOn = rows.length ? 'issuer_name' : matchedOn;
    }
  } else {
    rows = await pg<FormApRow[]>(
      cfg, FORM_AP,
      `select=*&issuer_name=ilike.*${encodeURIComponent(esc(raw))}*&order=audit_report_date.desc.nullslast&limit=1`,
    );
    matchedOn = 'issuer_name';
  }

  if (!rows.length) {
    return {
      found: false,
      company: raw,
      resolved_via: resolvedVia,
      reason: 'no_form_ap_filing',
      hint: `No PCAOB Form AP filing names an issuer matching "${raw}". This tool covers only issuers a PCAOB-registered firm has filed Form AP for (US public-company audits since 2017); a foreign private issuer, a company that never had a US-listed audit, or a name PCAOB spells differently would land here.`,
      caveat: CAVEAT,
    };
  }
  const r = rows[0];
  return {
    found: true,
    company: raw,
    resolved_via: resolvedVia,
    matched_on: matchedOn,
    issuer_name: r.issuer_name,
    issuer_cik: r.issuer_cik,
    firm_name: r.firm_name,
    firm_id: r.firm_id,
    firm_country: r.firm_country,
    engagement_partner: [r.engagement_partner_first, r.engagement_partner_last].filter(Boolean).join(' ') || null,
    engagement_partner_id: r.engagement_partner_id,
    audit_report_date: r.audit_report_date,
    fiscal_period_end_date: r.fiscal_period_end_date,
    num_participants: r.num_participants,
    caveat: CAVEAT,
  };
}

async function firmEngagements(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.firm ?? '').trim();
  if (!raw) throw new Error('user_error: `firm` is required — a firm name or numeric PCAOB Firm ID.');
  const limit = Math.min(500, Math.max(1, (args.limit as number) ?? 100));
  const fy = args.fiscal_year != null ? Number(args.fiscal_year) : null;

  const firmFilter = isDigits(raw) ? `firm_id=eq.${esc(raw)}` : `firm_name=ilike.*${encodeURIComponent(esc(raw))}*`;
  const fyFilter = fy && Number.isFinite(fy)
    ? `&fiscal_period_end_date=gte.${fy}-01-01&fiscal_period_end_date=lte.${fy}-12-31`
    : '';

  const rows = await pgAll<FormApRow>(
    cfg, FORM_AP,
    `select=issuer_name,issuer_cik,firm_id,firm_name,fiscal_period_end_date,audit_report_date,engagement_partner_first,engagement_partner_last` +
      `&${firmFilter}${fyFilter}&order=fiscal_period_end_date.desc.nullslast`,
    20000,
  );

  if (!rows.length) {
    return {
      found: false, firm: raw, fiscal_year: fy,
      reason: 'no_such_firm_or_no_engagements',
      hint: `No Form AP row matches firm "${raw}"${fy ? ` for fiscal year ${fy}` : ''}. Firm names vary by country affiliate ("PwC LLP" vs "PricewaterhouseCoopers LLP") — try a shorter fragment, or pass the numeric PCAOB Firm ID if known.`,
      caveat: CAVEAT,
    };
  }
  const firmIds = [...new Set(rows.map((r) => r.firm_id).filter(Boolean))];
  const firmNames = [...new Set(rows.map((r) => r.firm_name).filter(Boolean))];
  return {
    found: true,
    firm: raw,
    fiscal_year: fy,
    firm_ids_matched: firmIds,
    firm_names_matched: firmNames,
    total_engagements: rows.length,
    returned: Math.min(limit, rows.length),
    engagements: rows.slice(0, limit).map((r) => ({
      issuer_name: r.issuer_name,
      issuer_cik: r.issuer_cik,
      fiscal_period_end_date: r.fiscal_period_end_date,
      audit_report_date: r.audit_report_date,
      engagement_partner: [r.engagement_partner_first, r.engagement_partner_last].filter(Boolean).join(' ') || null,
    })),
    caveat: CAVEAT,
  };
}

async function partnerEngagements(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.partner ?? '').trim();
  if (!raw) throw new Error('user_error: `partner` is required — an engagement partner name.');
  const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 50));

  const parts = raw.split(/\s+/).filter(Boolean);
  const filter = parts.length > 1
    ? `engagement_partner_last=ilike.*${encodeURIComponent(esc(parts[parts.length - 1]))}*&engagement_partner_first=ilike.*${encodeURIComponent(esc(parts[0]))}*`
    : `engagement_partner_last=ilike.*${encodeURIComponent(esc(raw))}*`;

  const rows = await pgAll<FormApRow>(
    cfg, FORM_AP,
    `select=issuer_name,issuer_cik,firm_name,firm_id,engagement_partner_first,engagement_partner_last,fiscal_period_end_date,audit_report_date&${filter}&order=audit_report_date.desc.nullslast`,
    5000,
  );

  if (!rows.length) {
    return {
      found: false, partner: raw, reason: 'no_engagements',
      hint: `No Form AP engagement matches partner "${raw}". Try last name only.`,
      caveat: CAVEAT,
    };
  }
  return {
    found: true,
    partner: raw,
    partners_matched: [...new Set(rows.map((r) => [r.engagement_partner_first, r.engagement_partner_last].filter(Boolean).join(' ')))],
    total_engagements: rows.length,
    returned: Math.min(limit, rows.length),
    engagements: rows.slice(0, limit).map((r) => ({
      issuer_name: r.issuer_name,
      issuer_cik: r.issuer_cik,
      firm_name: r.firm_name,
      firm_id: r.firm_id,
      fiscal_period_end_date: r.fiscal_period_end_date,
      audit_report_date: r.audit_report_date,
    })),
    caveat: CAVEAT,
  };
}

async function auditorChanges(cfg: Cfg, args: Record<string, unknown>) {
  const days = Math.min(3650, Math.max(1, (args.days as number) ?? 90));
  const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 50));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  // Issuers with a filing in the window — candidates whose "latest" might be
  // a change. Capped: a large window can name thousands of issuers.
  const ISSUER_CAP = 1500;
  const recent = await pgAll<FormApRow>(
    cfg, FORM_AP,
    `select=issuer_id,issuer_name,issuer_cik,firm_id,firm_name,audit_report_date` +
      `&audit_report_date=gte.${cutoff}&issuer_id=not.is.null&order=audit_report_date.desc`,
    ISSUER_CAP * 2, // a popular issuer can file more than once in-window; over-fetch rows, cap issuers below
  );

  const latestByIssuer = new Map<string, FormApRow>();
  for (const r of recent) {
    if (!r.issuer_id) continue;
    const cur = latestByIssuer.get(r.issuer_id);
    if (!cur || (r.audit_report_date ?? '') > (cur.audit_report_date ?? '')) latestByIssuer.set(r.issuer_id, r);
  }
  const issuerIds = [...latestByIssuer.keys()].slice(0, ISSUER_CAP);
  const capped = latestByIssuer.size > ISSUER_CAP;

  const changes: Array<Record<string, unknown>> = [];
  const CHUNK = 100;
  for (let i = 0; i < issuerIds.length; i += CHUNK) {
    const batch = issuerIds.slice(i, i + CHUNK);
    // Prior filing per issuer, i.e. the second-most-recent overall (not just
    // within the window) — fetched per issuer via a chunked IN query on the
    // two most recent rows would need a window function PostgREST doesn't
    // expose, so this pulls a bounded recent history per batch and picks it
    // client-side.
    const history = await pg<FormApRow[]>(
      cfg, FORM_AP,
      `select=issuer_id,issuer_name,issuer_cik,firm_id,firm_name,audit_report_date` +
        `&issuer_id=in.(${batch.map((id) => `"${id}"`).join(',')})&order=issuer_id,audit_report_date.desc`,
    );
    const byIssuer = new Map<string, FormApRow[]>();
    for (const r of history) {
      const arr = byIssuer.get(r.issuer_id!) ?? [];
      arr.push(r);
      byIssuer.set(r.issuer_id!, arr);
    }
    for (const id of batch) {
      const rows = (byIssuer.get(id) ?? []).sort((a, b) => (b.audit_report_date ?? '').localeCompare(a.audit_report_date ?? ''));
      if (rows.length < 2) continue;
      const [latest, prior] = rows;
      if (latest.firm_id && prior.firm_id && latest.firm_id !== prior.firm_id) {
        changes.push({
          issuer_name: latest.issuer_name,
          issuer_cik: latest.issuer_cik,
          new_firm: latest.firm_name,
          new_firm_id: latest.firm_id,
          new_audit_report_date: latest.audit_report_date,
          prior_firm: prior.firm_name,
          prior_firm_id: prior.firm_id,
          prior_audit_report_date: prior.audit_report_date,
        });
      }
    }
  }

  changes.sort((a, b) => String(b.new_audit_report_date).localeCompare(String(a.new_audit_report_date)));

  return {
    days,
    cutoff_date: cutoff,
    issuers_scanned: issuerIds.length,
    issuer_scan_capped: capped,
    scan_cap_note: capped ? `More than ${ISSUER_CAP} issuers filed in this window; scan capped at ${ISSUER_CAP} (most recent first). Narrow \`days\` for a complete scan.` : undefined,
    total_changes: changes.length,
    returned: Math.min(limit, changes.length),
    changes: changes.slice(0, limit),
    caveat: CAVEAT,
  };
}

async function inspectionReports(cfg: Cfg, args: Record<string, unknown>) {
  const raw = String(args.firm ?? '').trim();
  if (!raw) throw new Error('user_error: `firm` is required — a firm name.');
  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 25));

  const rows = await pg<InspectionRow[]>(
    cfg, INSPECTIONS,
    `select=*&firm_name=ilike.*${encodeURIComponent(esc(raw))}*&order=inspection_report_date.desc&limit=${limit}`,
  );

  if (!rows.length) {
    return {
      found: false, firm: raw, reason: 'no_inspection_reports',
      hint: `No PCAOB inspection report matches firm "${raw}". Coverage starts 2018 for annually-inspected firms, 2019 for triennially-inspected firms.`,
      caveat: CAVEAT,
    };
  }
  return {
    found: true,
    firm: raw,
    firms_matched: [...new Set(rows.map((r) => r.firm_name))],
    returned: rows.length,
    reports: rows.map((r) => ({
      inspection_year: r.inspection_year,
      inspection_report_date: r.inspection_report_date,
      inspection_type: r.inspection_type,
      total_audits_reviewed: r.total_audits_reviewed,
      audits_with_part_1a_deficiencies: r.audits_with_deficiencies,
      part_1a_deficiency_rate_pct: r.deficiency_rate_pct,
      includes_public_qc_criticisms: r.includes_qc_criticisms,
      global_network: r.global_network,
      pdf_report_url: r.pdf_report_url,
    })),
    caveat: CAVEAT,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) throw new Error('pcaob is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  const cfg: Cfg = { url, key };

  switch (name) {
    case 'pcaob_auditor_of': return auditorOf(cfg, args);
    case 'pcaob_firm_engagements': return firmEngagements(cfg, args);
    case 'pcaob_partner_engagements': return partnerEngagements(cfg, args);
    case 'pcaob_auditor_changes': return auditorChanges(cfg, args);
    case 'pcaob_inspection_reports': return inspectionReports(cfg, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
