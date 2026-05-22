# V2 Report Thread Actions + Forum Tags

## Summary

Post-creation action buttons on report/feedback forum threads, plus automatic forum tag management.

---

## Foundation

- **`src/config.ts`** — add `staffRole: string` (from `STAFF_ROLE` env var)
- **Tag helper** — resolves tag names to IDs via `forum.availableTags.find()`:
  ```ts
  function resolveTagIds(forum: ForumChannel, names: string[]): string[]
  ```

---

## Phase 1 — Tag-Enabled Thread Creation

Tags applied at thread creation in `submitReport()` via a new `appliedTags` param:

| Report type | Tags |
|-------------|------|
| Bug | `OPEN`, `BUG` |
| Feedback | `OPEN`, `FEEDBACK` |
| Feature Request | `OPEN`, `FEATURE REQUEST` |

The `handleBugSubmit` / `handleFeedbackSubmit` callers pass the tag list through to `submitReport()`:

```ts
await submitReport(interaction, {
  ...
  appliedTags: resolveTagIds(publicForum, ['OPEN', 'BUG']),
});
```

Applied inside `submitReport()`:

```ts
await forum.threads.create({
  name: ...,
  message: ...,
  appliedTags: params.appliedTags,
});
```

---

## Phase 2 — Action Buttons

New button row on each thread's starter message (added in `submitReport()` after the embed edit):

```
[📝 Additional Report] [👤 Assign] [🔀 Merge] [🔒 Close]
```

### 2a. Assign (`handleAssign`)

| Aspect | Detail |
|--------|--------|
| Role-locked | Yes (`hasStaffRole`) |
| Custom ID | `assign_{ticketId}` |
| Tags | Add `ASSIGNED`, remove `UNASSIGNED` (if they exist) |
| Embed | Add `👤 Assigned to: <@userId>` field |
| Thread | `interaction.channel.members.add(interaction.user.id)` |
| Reply | Ephemeral confirmation |

### 2b. Close (`handleClose`)

| Aspect | Detail |
|--------|--------|
| Role-locked | Yes |
| Custom ID | `close_{ticketId}` |
| Tags | Replace `OPEN` with `CLOSED` |
| Thread | `setLocked(true)` + `setArchived(true)` |
| Embed | Add `🔒 Closed` field |
| Reply | Ephemeral confirmation |

### 2c. Additional Report (`handleAdditionalReportSubmit`)

| Aspect | Detail |
|--------|--------|
| Role-locked | No |
| Custom ID | `additional_report_{ticketId}` |
| Tags | No change |
| Flow | Modal → route validation → post embed in same thread with `[✂️ Split to Thread]` button |

### 2d. Merge (`handleMerge`)

| Aspect | Detail |
|--------|--------|
| Role-locked | Yes |
| Custom ID | `merge_{ticketId}` |
| Tags | Source thread: `OPEN` → `CLOSED` |
| Flow | Modal asks for target thread → post report embed in target → cross-link → close source |

### 2e. Split to Thread (`handleSplitToThread`)

| Aspect | Detail |
|--------|--------|
| Role-locked | Yes |
| Custom ID | `split_{ticketId}_{subId}` |
| Tags | New thread gets `OPEN, {type}` |
| Flow | Create new thread with report embed → cross-link both ways |

---

## Phase 3 — Registration

### `src/handlers/buttons.ts`

```ts
@ButtonComponent({ id: /^assign_/ })
@ButtonComponent({ id: /^additional_report_/ })
@ButtonComponent({ id: /^merge_/ })
@ButtonComponent({ id: /^close_/ })
@ButtonComponent({ id: /^split_/ })
```

### `src/handlers/modals.ts`

```ts
@ModalComponent({ id: /^additional_report_modal_/ })
@ModalComponent({ id: /^merge_modal_/ })
```

### `src/index.ts`

Add import for `report-actions.js`.

---

## Tag Lifecycle

| Event | Tags Before | Tags After |
|-------|-------------|------------|
| Thread created (Bug) | — | `OPEN, BUG` |
| Thread created (Feedback) | — | `OPEN, FEEDBACK` |
| Thread created (Feature) | — | `OPEN, FEATURE REQUEST` |
| Assign | `OPEN, {type}` | `OPEN, {type}, ASSIGNED` |
| Close | `OPEN, {type}` (± ASSIGNED) | `CLOSED, {type}` (± ASSIGNED) |
| Merge (source) | `OPEN, {type}` | `CLOSED, {type}` |
| Additional Report | no change | no change |
| Split to Thread (new) | — | `OPEN, {type}` |

---

## Files Changed

| File | Changes |
|------|---------|
| `src/config.ts` | +`staffRole` field |
| `src/handlers/report.ts` | Add `appliedTags` param to `submitReport()`; add action button row after embed edit |
| `src/handlers/report-actions.ts` | **New** — all handlers + tag helpers |
| `src/handlers/buttons.ts` | +5 `@ButtonComponent` |
| `src/handlers/modals.ts` | +2 `@ModalComponent` |
| `src/index.ts` | +import |

~340 lines new code.
