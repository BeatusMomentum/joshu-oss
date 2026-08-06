# Filing user product notes & ideas into project journals

When the owner sends a note/idea (via email, Slack, or voice) that belongs in a product or project folder, use this filing workflow.

## Workflow

### 1. Determine target project

Most product ideas go to the box's primary product slug (often `joshu-product-development` on Joshu boxes). Check the note content:
- Product feature/architecture/design idea → primary product project
- User onboarding, investor relations, partnerships → project-specific slug

### 2. Find the latest journal

List journals under `Projects/<slug>/` on disk (gbrain for search, but write on disk):

```
ls ${JOSHU_FILES_ROOT}/Projects/<slug>/journal_*.md | sort -r | head -3
```

Read the latest one to see its format and the last entry.

### 3. Create or update the journal entry

**New day:** Create `journal_YYYY-MM-DD.md` — only if today's date doesn't already have a file.
**Same day as existing entry:** Append to the existing file instead.

Format (see any existing journal):

```markdown
# YYYY-MM-DD

## Owner notes (Mon DD) — [short label]

Owner shared a product idea via [channel]:

N. **Title** — Description of the idea. Key details.

Source: [Voice conversation / connectors/mail/...]
```

### 4. Update about.md if the idea is structural

The project's `about.md` may need updates in up to two places:

**Design Concepts table** (if the idea is a reusable design pattern, not a one-off task):
- Add a new row: `| **Concept name** | *Filed YYYY-MM-DD from owner's [channel]* — Description |`

**Active threads section** (for any note, even quick reminders):
- Add a bullet for the note with a short label and what was filed.

### 5. Save to memory

Use `memory(action='add', target='memory')` with a one-line summary so the idea can be recalled in future sessions without re-reading files.

## Tips

- Journal entries are timestamp records. They never get overwritten — always create a new date entry.
- `about.md` is the living reference. It gets updated as ideas evolve.
- For quick/brief notes: a journal entry + active thread line is sufficient. Only add to Design Concepts if the idea is a novel, reusable product concept.
- If the same idea was previously filed (check gbrain), note it as a `(re-up)` instead of duplicating.
