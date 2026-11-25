# VidLink – is it addable?

**Short answer: no — and not for the reason I gave you twice before. I had this wrong, and this run corrects it.**

## What was actually measured

Four titles, one file at a time, six seconds apart, with a retry after the wait the host itself asked for:

| attempt | fight-club | inception | got-s1e1 | naruto-s1e1 |
| — | — | — | — | — |
| adapter headers | 429 | 429 | 429 | 429 |
| bare (UA only) | 429 | **428** | **428** | **428** |
| after 15 s wait | 429 | 429 | 429 | 429 |

Every response is `content-type: text/html`, `server: nginx`. **Not one byte of media.**

Two responses carry the whole answer:

- **428 Precondition Required** (14-byte body) appears *only* when the adapter's headers are stripped. So the host wants a Referer/Origin, and the adapter already sends one.
- **429 with a 587-byte body** appears on **every** attempt with headers, on the **first** fetch of each title, and again after a 15-second wait.

That is not a burst limit. A burst limit clears when you stop bursting. This is the first request of each title being refused, from a host that tells you what precondition it wants and then refuses you when you send it.

## The correction I owe you

I called this "throttling" twice, and I used that to argue *for* adding vidlink, on the theory that a throttled second lane is still a second lane. **That argument was wrong**, because it assumed the 429 was caused by greybox-style rate-limiting.

`hakunaymatata` has never been on the live board. It is **vidora**. And the latest board measurement returns only `img1.hscow.com` and `greyboxtv.duckdns.org` — `hakunaymatata` did not appear at all this run. Something that fails on the first request of every title is not a lane you can lean on when greybox throttles. It is a third lane that also fails.

## Two independent reasons it is refused

Either one is sufficient:

1. **It cannot pass the contract gate.** The gate requires measured bytes, and four titles through three fetch strategies produced zero. Whatever else is true of vidlink, nothing here can be registered — that is not a judgement call, it is the gate.

2. **It is vidora.** On `movie/27205`, vidora returned `resource/a58dd00af907b9b8cc3b5c04b1a422c9.mp4` and vidlink returned the same 32 hex characters on a sibling subdomain. One object, two front-ends. Even if the host started serving tomorrow, adding it would add a new name for media that already has one.

## What is still true

The adapter is correct, and that is worth keeping:

- token mints locally, no third party in the resolve path, proven by test;
- `/api/b` accepted the token on all four titles — the protocol is solved;
- both payload shapes read, `auto` playlist handled, duplicate collapse;
- the inherited zero-nonce bug is fixed.

So if that host ever starts serving to datacenter IPs, the adapter is a day from being usable and the proof is one runner job. Until then it stays in the tree, unregistered, with this document as the reason.

## If a third source is still wanted

The lane that survives every measurement is **anime** — Novus, MegaPlay, AnimeSalt. The board serves zero anime today, so there is no overlap to worry about, and the `hsc:` / `hex:` object-id comparison now exists to prove it properly rather than by hostname.
