# Media pipeline

Short vertical video and photos are the "SHOW" in DO → LOG → SHOW, so media is a first-class resource
with its own lifecycle, separate from posts: **upload bytes → validate → re-encode → publish variants →
attach to a post**. Large bytes never pass through the API; the API only authorises, verifies and
orchestrates.

```mermaid
sequenceDiagram
  participant App
  participant API
  participant Store as Object storage
  participant W as Worker (ffmpeg)
  App->>API: POST /v1/media/uploads {kind, mimeType, sizeBytes}
  API-->>App: {media (PENDING_UPLOAD), upload {method: PUT, url, headers, expiresAt}}
  App->>Store: PUT bytes (exactly those headers, no auth header)
  App->>API: POST /v1/media/{id}/complete
  API->>Store: HEAD (exists? size == declared?)
  API-->>App: media (UPLOADED → PROCESSING); job queued
  W->>Store: download original
  W->>W: ffprobe → validate → ffmpeg variants (metadata stripped)
  W->>Store: upload variants
  W->>API: (DB) status → READY | FAILED | REJECTED
  App->>API: GET /v1/media/{id} (poll while PROCESSING)  — or just create the post and let it wait
  App->>API: POST /v1/posts {mediaIds:[id], …}  — PENDING_MEDIA until READY, then PUBLISHED
```

## States

```
PENDING_UPLOAD ─► UPLOADED ─► PROCESSING ─► READY ──────────► REJECTED (takedown)
                                   │  ▲
                                   ├──┴─► FAILED   (transient: POST /media/{id}/retry → PROCESSING)
                                   └────► REJECTED (permanent: bad file / policy)
```

- Transitions are enforced **by a database trigger**, not only by code; a row cannot become `READY`
  unless its metadata and required variants exist ([`DATABASE.md`](DATABASE.md#the-important-constraints-and-triggers)).
- `status`, `failureCode`, dimensions, duration and signed `urls` are all on the `Media` resource
  ([`FRONTEND_INTEGRATION.md`](FRONTEND_INTEGRATION.md#5-uploading-media)). URLs exist only for `READY` media.
- A post attached to unfinished media is `PENDING_MEDIA` (visible to its author only) and **publishes
  itself** when every item is `READY` (a job fires on each status change); if one fails permanently
  it becomes `PUBLISH_FAILED` and the author is notified. So the client can create the post immediately
  after `/complete` and show "processing…" instead of blocking on transcoding.

## Limits and accepted formats

`GET /v1/media/limits` returns the live values; validate on the device before uploading.

| Limit                             | Default                                                                     | Config                                                                       |
| --------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Video size / duration             | 300 MB / 180 s (+0.5 s tolerance)                                           | `MEDIA_MAX_VIDEO_BYTES`, `MEDIA_MAX_VIDEO_SECONDS`                           |
| Image size / pixels               | 25 MB / 80 MP                                                               | `MEDIA_MAX_IMAGE_BYTES`, `MEDIA_MAX_PIXELS`                                  |
| Video resolution                  | ≤ 3840×2160 (4K) accepted; ≥ 64 px per side                                 | –                                                                            |
| Media per post                    | 10                                                                          | –                                                                            |
| Un-attached upload slots per user | 20                                                                          | `RATE_LIMITED` with `Retry-After` when exceeded                              |
| Video types                       | `video/mp4`, `video/quicktime` (iPhone `.mov`), `video/webm`, `video/x-m4v` | –                                                                            |
| Image types                       | `image/jpeg`, `image/png`, `image/webp`                                     | HEIC/HEIF is **not** accepted: have the client convert (iOS: export as JPEG) |
| Upload URL lifetime               | 15 min                                                                      | `UPLOAD_URL_TTL_SECONDS`                                                     |
| Playback URL lifetime             | 6 h                                                                         | `MEDIA_URL_TTL_SECONDS`                                                      |
| Upload endpoints                  | 30 requests/min/user                                                        | rate-limit profile `upload`                                                  |

The declared type and size are **signed into the upload URL** (S3 rejects a PUT that differs), and `complete`
re-checks the stored size against the declaration (mismatch ⇒ the object is deleted and
`422 UPLOAD_INCOMPLETE`). The _declared_ MIME type is never trusted for processing: ffprobe decides.

## Validation (worker)

1. `ffprobe` the original. Not readable ⇒ `REJECTED / INVALID_MEDIA`.
2. Container/codec allow-list (MP4/MOV family and Matroska/WebM for video; JPEG/PNG/WebP for images),
   with a video stream present ⇒ else `UNSUPPORTED_FORMAT` / `INVALID_MEDIA`.
3. Duration ⇒ `TOO_LONG`; pixel count ⇒ `TOO_LARGE_DIMENSIONS`; tiny dimensions ⇒ `TOO_SMALL`.
4. Image moderation hook (`ContentModerator.moderateImage`) ⇒ `MODERATION_REJECTED`. **The shipped adapter
   approves everything** (stub) — see [`SECURITY.md`](SECURITY.md#known-gaps).
5. Re-encode **everything**. The original is never served (the storage route answers `404` for it and S3
   objects are only ever read through signed URLs of _variants_).

Failure codes (`Media.failureCode`):

| Code                                            | Kind                                               | Meaning / client message                                                                                          |
| ----------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `INVALID_MEDIA`, `UNSUPPORTED_FORMAT`           | permanent (`REJECTED`)                             | "That file couldn't be used"                                                                                      |
| `TOO_LONG`, `TOO_LARGE_DIMENSIONS`, `TOO_SMALL` | permanent (`REJECTED`)                             | Show the specific limit                                                                                           |
| `MODERATION_REJECTED`                           | permanent (`REJECTED`)                             | "This doesn't meet our guidelines"                                                                                |
| `PROCESSING_ERROR`                              | transient (`FAILED`) after 3 attempts with backoff | Offer **retry** → `POST /v1/media/{id}/retry`                                                                     |
| `TAKEN_DOWN`                                    | reserved                                           | Not produced yet: hidden/removed _posts_ simply stop being visible; media-level takedown is a future staff action |

## Variants produced

| Kind                                 | Spec                                                                                                                                 | Used for                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `VIDEO_MP4_HIGH` (`urls.playback`)   | H.264 High / AAC, yuv420p, fit within **720×1280** (landscape: 1280×720), never upscaled, ≤ 30 fps, CRF 23, max 4 Mbps, `+faststart` | Main feed playback                |
| `VIDEO_MP4_LOW` (`urls.playbackLow`) | fit within 360×640, CRF 28, max 1 Mbps                                                                                               | Data-saver / slow networks        |
| `POSTER` (`urls.poster`)             | JPEG still at ~1 s (or half the clip if shorter), same box as HIGH                                                                   | Video placeholder before playback |
| `POSTER_THUMB` (`urls.thumbnail`)    | JPEG ≤ 480 px                                                                                                                        | Grids, notifications              |
| `IMAGE_LARGE` (`urls.large`)         | JPEG ≤ 2048 px                                                                                                                       | Full-screen photo                 |
| `IMAGE_MEDIUM` (`urls.medium`)       | JPEG ≤ 1080 px                                                                                                                       | Feed photo                        |
| `IMAGE_THUMB` (`urls.thumbnail`)     | JPEG ≤ 480 px                                                                                                                        | Grids, avatars                    |

Avatars (`purpose: AVATAR`) are centre-cropped to a square. Every output is built with
`-map_metadata -1 -map_chapters -1 -sn -dn`: **all metadata (GPS EXIF/QuickTime location, device info)
is removed from everything that is served**. MP4s are progressive with `faststart`, so they stream with
HTTP range requests from any static origin/CDN — there is deliberately no HLS/DASH yet.
Rotation metadata is applied by ffmpeg's autorotate when encoding, so outputs are upright.

> **Originals are retained** in object storage (for re-processing/forensics) but never served. They _do_
> still contain whatever metadata the phone wrote (including GPS). They are deleted with the media,
> the post or the account. If you prefer not to keep them at all, delete the original after READY
> (one line in `MediaService.process`; trade-off: no re-processing with a better encoder later).

## Delivery

- `GET` resources embed **signed URLs** (`urls`, `urlsExpireAt`). With S3/R2 they are native presigned
  GETs; with the dev driver they are `…/v1/storage/files/<key>?exp=…&sig=…` served by the API (HMAC,
  Range support). Re-fetch the owning post/media when they expire; never store them.
- Keys are `media/<ownerId>/<mediaId>/<variant file>` — never guessable _and_ never relied on for secrecy.
- **Authorization is at URL minting time.** A URL is only generated for a viewer who may see the _post_
  (visibility, blocks, moderation state are applied when the post is hydrated); anyone holding a valid URL
  can fetch the file until it expires (≤ 6 h). That is the standard signed-URL trade-off; shorten
  `MEDIA_URL_TTL_SECONDS` if posts are sensitive, or put an authorising CDN/worker in front.
- Signed URLs differ per request, so they defeat shared CDN caching unless the CDN keys its cache on the
  path only (CloudFront / Cloudflare can ignore the signature query param after validating it) — see
  [Scaling](#scaling).

## Cleanup (jobs)

| Job                            | What                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media.cleanup` (every 15 min) | Deletes `PENDING_UPLOAD` slots whose URL expired > 1 h ago; deletes **orphans** (never attached to a post/avatar) older than `MEDIA_ORPHAN_RETENTION_DAYS` (14) |
| `media.delete_objects`         | Removes stored files after a post/media/account deletion (queued in the same transaction as the row deletion, retried until it succeeds)                        |
| On `REJECTED`                  | The original is dropped immediately; `FAILED` keeps it so a retry can run                                                                                       |

Deleting a post deletes its media. A media item _removed from_ a post (`DELETE /posts/{id}/media/{mediaId}`)
stays in the user's library (and becomes eligible for orphan cleanup).

## Storage drivers

| `STORAGE_DRIVER`  | For                   | Notes                                                                                                    |
| ----------------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| `local` (default) | Development and tests | Files under `LOCAL_STORAGE_DIR`; the API serves signed upload/download routes. **Refused in production** |
| `s3`              | Production            | Any S3-compatible service: AWS S3, Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces…              |

### S3 setup

_(Human steps — the repository cannot do these for you.)_ The driver is verified against an in-test fake
S3 for request shapes and error handling; **signature validity against a real provider has not been
exercised here — do one real upload end to end as the first step.**

1. Create a **private** bucket (block all public access). Versioning is optional.
2. Create an access key restricted to that bucket with `s3:GetObject`, `PutObject`, `DeleteObject`,
   `ListBucket` (no ACL, no bucket-policy permissions).
3. **CORS** on the bucket (needed for browser uploads; native apps ignore it):
   `AllowedMethods: PUT, GET, HEAD` · `AllowedOrigins: your web origins` · `AllowedHeaders: content-type, content-length` ·
   `ExposeHeaders: ETag` · `MaxAgeSeconds: 3000`.
4. Lifecycle rule: abort incomplete multipart uploads after 1 day (the app uses single PUTs, but be safe).
5. Set `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, and for
   non-AWS providers `S3_ENDPOINT` (+ `S3_FORCE_PATH_STYLE=true` for MinIO/most self-hosted).
6. R2 notes: region `auto`, endpoint `https://<account>.r2.cloudflarestorage.com`.
7. Smoke test: `POST /v1/media/uploads` → `PUT` the returned URL with _exactly_ the returned headers →
   `POST /v1/media/{id}/complete` → poll until `READY`.

## Scaling

- **CPU.** ffmpeg dominates. One worker process runs `WORKER_CONCURRENCY` (4) jobs, each ffmpeg using 2
  threads: size the **worker** deployment separately from the API and scale replicas on queue depth
  (`select count(*) from jobs where status='PENDING' and name='media.process'`). Throughput has not been
  benchmarked in this repository: measure a representative clip on your target hardware before sizing.
- **Bandwidth.** All downloads go straight from storage/CDN to the device. Put a CDN in front of the
  bucket and make it cache on path (ignoring the signature) once traffic justifies it.
- **Disk.** The worker needs scratch space for one original + variants per concurrent job (≤ ~1 GB at
  the 300 MB limit); it uses the OS temp dir and always cleans up.
- **Beyond progressive MP4.** For longer videos or adaptive bitrate, add an HLS ladder variant kind, or
  swap `ffmpeg` for a managed transcoder behind the same `MediaService.process` seam (Mux, Cloudflare
  Stream, MediaConvert). Webhooks/job states already map cleanly onto `PROCESSING → READY|FAILED`.
- **Resumable uploads** (tus / S3 multipart) are not implemented; with a 300 MB cap a single PUT works
  on mobile, but flaky networks would benefit from multipart. The `/complete` contract does not change.
- **Virus/malware scanning and CSAM hash matching** are not implemented (re-encoding neutralises most
  payloads but is not a scan).
