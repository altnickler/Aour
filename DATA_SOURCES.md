# Data sources and licensing

Aour separates two questions:

1. **Does this venue exist, and where is it?** Answered by licensed place-data providers.
2. **Does it have a happy hour, and what is it?** Answered only by the venue itself (its own website), by people (users and admins), or optionally by OpenStreetMap's `happy_hours` tag.

A venue from a provider is a *candidate*. Its happy-hour status is `none` until real facts exist, and the app labels such venues "Unconfirmed" in a separate section.

> **Legal review required before launch.** This is an engineering summary, not legal advice. The items in the last section need a lawyer's sign-off.

## Venue (place) data providers

Default first. Each adapter lives in `src/pipeline/providers/`; pure mappings are in `src/core/ingest/providers.ts`.

### Overture Maps — Places (default, on)

- **Licence:** CDLA-Permissive-2.0. Some sources are Apache-2.0 or CC0.
- **Store / display:** yes, with attribution. No share-alike.
- **How we use it:** a monthly GeoParquet release on public S3. DuckDB reads only each market's bounding box (`overture` budget).
- **Cost:** $0.

### OpenStreetMap via Overpass (opt-in, off)

- **Licence:** ODbL 1.0.
- **Store / display:** yes, with "© OpenStreetMap contributors". Mixing OSM rows with other venue data creates a *Derivative Database* that must be offered under ODbL if used publicly.
- **How we use it:** one Overpass query per market per run (`osm_overpass` budget, disabled). Also the only source of `happy_hours=*` tags.
- **Cost:** $0. Fair-use limits on the public instance.

### Foursquare Places API (opt-in, off)

- **Licence:** commercial API terms.
- **Store / display:** **only `fsq_place_id` may be stored.** Other fields must not be cached server-side.
- **How we use it:** link-only. `pipeline_upsert_place` refuses to create or update anything from it (`foursquare` budget, disabled).
- **Cost:** pay-as-you-go *(verify current pricing)*.

### Foursquare Open Source Places (not wired yet)

- **Licence:** Apache-2.0.
- **Store / display:** yes, with attribution.
- **Use:** possible future bulk source (`fsq_os` is reserved in the schema).
- **Cost:** $0.

### Rejected

- **Google Places:** its terms prohibit storing Places content beyond place IDs and limited caching, and require display on a Google map.
- **Yelp Fusion:** its terms restrict caching and require specific display.
- **Scraping Google Maps, Yelp, TripAdvisor or similar sites:** prohibited by their terms. `NEVER_CRAWL` in `src/core/ingest/refresh.ts` blocks these domains outright.

### Matching and de-duplication (`src/core/ingest/match.ts`)

1. Same provider and same stable ID → same place.
2. Otherwise score name similarity (Jaro-Winkler on normalised tokens) and distance. Places more than 400 m apart are always different. Same website domain or phone adds to the score; a conflicting one subtracts.
3. Score ≥ 0.85 links automatically. Between 0.60 and 0.85, the new place is held as a draft plus a "possible duplicate" for an admin. Below 0.60, a new place is created.

**Licence attribution.** Every imported row keeps an `attribution` string (shown on the place page) and an `establishment_external_ids` row.

## Happy-hour facts

### The venue's own website

- Fetched by `src/pipeline/fetcher.ts` with user agent `AourBot/1.0 (+https://aour.app/bot)`.
- Honours robots.txt (RFC 9309), including AourBot-specific rules and Crawl-delay. The cached copy lives 24 h; a 5xx robots response means "crawl nothing".
- At most one request per host every 5–30 s, shared across workers.
- Fetches the homepage plus at most 3 same-site pages (happy-hour, specials, menu). Never ordering, social or aggregator sites.
- Uses conditional GET (ETag / Last-Modified) and a content hash, so unchanged pages cost almost nothing.
- Accepts HTML only, capped at 1.5 MB, with a 10 s timeout. Redirects are followed within the same site only.
- **Stops** on 401/403, CAPTCHA or bot challenges (the domain is blocked until an admin lifts it), and 429 / Retry-After. It never tries to get around a paywall, login, CAPTCHA or anti-bot control.

### Extraction (`src/core/ingest/extract.ts`)

- Deterministic: schema.org JSON-LD first, then text patterns limited to the happy-hour section of the page.
- Each fact keeps a short verbatim evidence quote.
- Ambiguous text ("Happy hour 4-7" with no days) is **not guessed**. It is marked "mentioned but unparsed" and queued for a human.

### Optional AI-assisted extraction

- **Off by default** (`llm_extract` budget disabled).
- Uses the Claude API on the happy-hour sections of a page we already fetched legitimately.
- Every fact must carry a quote that appears *verbatim* in the page. Prices must appear inside that quote. Anything else is dropped (`validateFinding`).
- AI findings **always go to admin review**. They are never published or verified automatically.

### Other sources

- **OpenStreetMap `happy_hours` tag** (when OSM is enabled): stored as "Community reported".
- **Users:** suggestions and "report outdated" go to the admin queues and are never auto-published.
- **Admins:** verify, edit, approve or reject findings, merge duplicates, and lock a listing.

### What is stored

Normalised facts plus permitted provenance:

- days, start/end times, specials with the price exactly as published, restrictions;
- source URL, published date when the page states one, checked date;
- short evidence quotes;
- conditional-GET validators and content hashes.

What is **not** stored: page bodies and images.

## Automatically retrieved information

| Field | Source | Notes |
|---|---|---|
| Venue name, category, coordinates, address, website, phone | Overture (and OSM if enabled) | Imported rows follow the provider unless an admin locked the field |
| Business opening hours | OSM `opening_hours`; JSON-LD `openingHoursSpecification` | Shown separately from happy hour |
| Permanently closed | Overture `operating_status`, OSM lifecycle tags | Archives imported, unlocked listings |
| Happy-hour days and times | Venue website (JSON-LD / text); OSM `happy_hours` | Unknown stays unknown |
| Specials and prices | Venue website | Price exactly as written, or none |
| Restrictions | Venue website ("bar area only", "not on holidays") | |
| Source URL, publication date, date checked | Fetcher | |

**Not retrieved automatically:**

- photos (licensed uploads only);
- reviews or ratings from any third party;
- anything from social networks or review sites.

## Verification statuses (shown to users)

| Status | Meaning | Who can set it |
|---|---|---|
| **Verified** | Confirmed by an Aour admin against a recorded source. Expires to "may have changed" after 90 days and "likely outdated" after 180 | Admins only (the pipeline is blocked in SQL from setting it) |
| **Reported by venue** | Published on the venue's own website | Pipeline (deterministic extraction from the official site) |
| **Community reported** | Users or OpenStreetMap | Pipeline / admins |
| **Needs verification** | Low confidence, conflicting sources, or AI-assisted | Pipeline / admins |
| **Outdated** | Not re-confirmed for 180 days, or the site stopped mentioning it | Pipeline (auto-managed rows only) / admins |
| **No happy-hour info** | Nothing found | Default |

- **Confidence** (reliability × recency + corroboration, capped at 0.5 on conflict) is internal only. It is not readable through the public API.
- **Admin overrides:** an admin edit locks the listing (`hh_managed_by = 'admin'`). From then on, automation can only propose findings, until an admin explicitly hands it back.

## Geocoding (city / address search)

- Photon (komoot's public instance), proxied by the Worker.
- Results are built from OpenStreetMap data (ODbL) and shown with "© OpenStreetMap contributors".
- Queries are cached at the edge, rate-limited per IP and budgeted (`geocode`). They are not stored in the database.
- The public instance is fair-use with no SLA. At scale, use a paid or self-hosted geocoder (it only needs a change in `worker/index.ts`).

## Items needing legal review

1. **Overture attribution wording and placement.** Also confirm the licence of the specific Overture sources in each release.
2. **OpenStreetMap / ODbL** before enabling OSM:
   - Is the merged venue table a Derivative Database that must be shared under ODbL?
   - Or can OSM rows be kept as a separable "collective database"?
   - Is the "Produced Work" attribution sufficient?
3. **Venue website crawling:**
   - Is a robots-honouring, low-rate crawler of official venue sites acceptable under each site's terms of use? Some terms forbid automated access even when robots.txt allows it. Consider honouring "noai" / "noindex" meta tags, and offer a public opt-out at `https://aour.app/bot`.
   - Does storing short verbatim evidence quotes (admin-only) and normalised facts fall within fair use / database-right limits in the US?
4. **AI-assisted extraction:** sending fetched page sections to the Claude API, under Anthropic's commercial terms and data-retention settings.
5. **Foursquare Places API terms**, if enabled: storage of IDs only, attribution, and display requirements.
6. **Photon public instance** usage policy for a commercial app. Consider a paid geocoder.
7. **Trademark and right-of-publicity** issues in showing venue names and specials, and the "Reported by venue" wording.
8. **Privacy policy:**
   - coarse location stays on the device;
   - anonymous coverage requests are rounded to about 11 km;
   - geocoding queries pass through the Worker to Photon.
