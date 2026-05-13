# Wiki Schema

You maintain this wiki — it is your persistent knowledge base.
Read this document first. It defines the structure, conventions, and workflows for every operation.

## Three-Layer Architecture

**Raw sources** (`raw/`) — Immutable Q&A exchanges. One file per Discord thread.
You read these to understand what happened. Never modify them.

**The wiki** (`concepts/`, `entities/`, `users/`) — Your workspace.
You create, update, cross-reference, and maintain all pages here.
You own this layer. Write it well.

**This schema** (`SCHEMA.md`) — Governance rules.
Co-evolve this file over time as the wiki grows.

## Directory Structure

```
wikis/
  SCHEMA.md       # This file — structure, conventions, workflows
  index.md        # Content catalog — update on every change
  log.md          # Append-only operation log
  concepts/       # Codebase concepts (fingerprinting, CAN bus, safety model)
  entities/       # Physical things (car models, hardware devices, people)
  users/          # Community member profiles
  raw/threads/    # Immutable Q&A exchanges, one .md per thread
```

## Naming Conventions

- **Concepts**: PascalCase — `Fingerprinting.md`, `CarParams.md`, `SafetyModel.md`
- **Entities**: PascalCase — `CommaThree.md`, `HyundaiSonata2020.md`, `Panda.md`
- **Users**: Discord user ID — `123456789012345678.md`
- **Raw threads**: Discord thread ID — `987654321098765432.md`
- **index.md** entries: `[[PageName]] — one-line summary`

## YAML Frontmatter

Every wiki page must start with YAML frontmatter:

```yaml
---
title: "Page Title"
type: concept | entity | user
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [tag1, tag2]
sources: [raw/threads/threadId.md]
---
```

The `sources` field should reference the raw thread file(s) the information came from.
Keep `created` and `updated` dates accurate.

## Cross-References

Use `[[wiki-link]]` notation to link to other pages. Every page must link to at least one other page. No orphan pages.

Link to related concepts, entities, and users. If a user drives a car that has an entity page, link from the user page to the car entity, and vice versa.

## Contradictions

If new information contradicts an existing page, do NOT silently overwrite. Instead, add a `## Conflicts` section:

```markdown
## Conflicts
- **Claim from [[other-page]]**: says X
- **New evidence** (source: raw/threads/id.md): says Y
- **Resolution**: unclear — both claims retained pending more data
```

This preserves conflicting knowledge until more evidence resolves it.

## index.md Maintenance

`index.md` is the table of contents. The LLM reads this first to navigate the wiki.

Format:
```markdown
# Wiki Index

## Concepts
- [[Fingerprinting]] — how StarPilot identifies car models via CAN messages

## Entities
- [[CommaThree]] — Snapdragon-based comma device

## Users
- [[123456789]] — drives a 2020 Hyundai Sonata
```

Update `index.md` every time you create a new page or significantly change an existing one.
Remove orphan entries when pages are deleted. Keep summaries accurate and concise.

## log.md Maintenance

`log.md` is append-only. Add an entry after every operation:

```
## [2026-05-12] update | Created [[Fingerprinting]], updated [[HyundaiSonata2020]]
## [2026-05-12] query | User asked about CAN bus — answered from [[CarParams]] and [[Fingerprinting]]
## [2026-05-12] lint | Found 1 orphan [[UnlinkedPage]], fixed dead link to [[OldPage]]
```

Use consistent prefixes so the log is parseable:
- `ingest` — new knowledge added from a source
- `update` — existing pages modified
- `query` — question answered using wiki
- `lint` — health check performed

## Operations

### Query (when asked a question)
1. Read `index.md` to find relevant pages
2. Read those pages for context
3. Synthesize an answer citing code and `[[wiki-link]]` references
4. Good answers can be filed as new wiki pages

### Ingest (when new knowledge arrives)
1. Read the source (raw thread or code)
2. Update or create relevant concept, entity, and user pages
3. Cross-reference new pages with existing ones
4. Update `index.md`
5. Append to `log.md`

### Lint (when asked to check the wiki)
1. Scan all pages for broken `[[wiki-link]]` references
2. Find orphan pages with no inbound links
3. Check for contradictions between pages
4. Report findings and fix what you can
