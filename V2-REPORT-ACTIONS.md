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

Tags applied at thread creation in `handleBugSubmit` / `handleFeedbackSubmit`:

| Report type | Tags |
|-------------|------|
| Bug | `OPEN`, `BUG` |
| Feedback | `OPEN`, `FEEDBACK` |
| Feature Request | `OPEN`, `FEATURE REQUEST` |

Applied via `appliedTags` in `forum.threads.create()`:

```ts
await publicForum.threads.create({
  name: ...,
  message: ...,
  appliedTags: resolveTagIds(publicForum, ['OPEN', 'BUG']),
});
```

---

## Phase 2 — Action Buttons

New button row on each thread's starter message (added after thread creation):

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
| `src/handlers/report.ts` | Add `appliedTags` to `threads.create()`; add action button row after creation |
| `src/handlers/report-actions.ts` | **New** — all handlers + tag helpers |
| `src/handlers/buttons.ts` | +5 `@ButtonComponent` |
| `src/handlers/modals.ts` | +2 `@ModalComponent` |
| `src/index.ts` | +import |

~340 lines new code.
