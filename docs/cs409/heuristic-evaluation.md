# Heuristic evaluation

CanvasWatcher is evaluated against Nielsen's 10 usability heuristics in two rounds:

- **Round 1 (week 4):** 3–5 evaluators work independently. Their findings are merged into one table.
- **Revision and round 2 (week 5):** the team fixes the problems it chose to fix, and the evaluators check those
  screens again. Before/after screenshots are recorded here.

**Status: round 1 has not been run yet.** This page is the kit: setup, tasks, forms and an empty merge table.
Results go below only after evaluators have actually recorded them. Do not fill in rows ahead of time or copy
problems from elsewhere.

## About the earlier problem list (REWRITE_PLAN §7.4)

`REWRITE_PLAN.zh-CN.md` §7.4 lists usability problems found before round 1. All of them were in the **old
interface**, which was deleted in week 3 (`517e146`). The screens, files and line numbers it cites no longer
exist. Those problems are not round 1 findings, so do not copy them into the tables below.

If an evaluator finds a similar problem in the current interface, record it as a new finding with what they
saw.

## Evaluators

- 3–5 people. Each works alone and does not see anyone else's notes until everyone has finished.
- Avoid evaluating screens you built yourself where you can. If a team member has to, note it on their form.
- Allow about 60–90 minutes per evaluator: tasks first, then a free look around.

## Setup

1. Open the course deployment, or run it locally and open `http://localhost:8080`. Locally, create `.env` first
   and give `SESSION_SECRET` and `CREDENTIALS_KEY` their own random values; the stack does not start without
   them:

   ```bash
   cp .env.example .env
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # once for each key
   docker compose up -d --build
   ```

   Demo accounts are on by default here (`DEMO_ACCOUNTS=true` in `docker-compose.yml`).

2. On the sign-in page, choose **Try a demo**. You do not need a Canvas account, a token or a password.
3. Each click creates a separate demo account. Evaluators never share one, and nobody sees anyone else's
   changes.

How the demo account behaves:

- It contains four sample courses with assignments, files, recent changes (three unread), a class schedule and
  a finished sync.
- Due dates are counted from the moment the demo starts, in the America/Chicago time zone. "Due today" means
  today there.
- **Reset data** in the banner at the top puts the sample data back.
- **End demo** deletes the account. Otherwise it is deleted after 7 days.
- One network can start 10 demos per hour. If a room of evaluators hits the limit, wait or use Reset data
  instead of starting a new demo.

Some things work differently in a demo because it has no real Canvas behind it:

- **Sync now** finishes at once and finds nothing new.
- **Download** and **Open in Canvas** show a short note instead of opening Canvas.
- Canvas cannot be connected, and there is no password to change.

These limits are not findings in themselves. If the way they are explained is confusing, that is a finding.

Evaluate at two widths and record which one each problem appears at:

- **Desktop:** a window at least 1024 px wide.
- **Phone:** a real phone, or the browser's device mode at about 375 × 812.

## The heuristics

Use the number when recording a problem. The prompts are starting points, not a checklist.

| # | Heuristic | Things to look at in CanvasWatcher |
|---|---|---|
| H1 | Visibility of system status | Do you know when the data was last synced, whether a sync is running and how it ended? After you change something, can you tell it was saved? |
| H2 | Match between the system and the real world | Are terms like "change", "slack", "busy" and "study window" clear to a student? Are dates and times read the way you would say them? |
| H3 | User control and freedom | Can you undo or back out of what you did: completing a task, archiving a course, closing an editor with unsaved changes? |
| H4 | Consistency and standards | Do the same actions look and behave the same on every page and at both widths? Do links and buttons behave as expected? |
| H5 | Error prevention | Does the interface stop you before something you can't take back, such as a delete, a disconnect or ending the demo? Are form limits clear before you submit? |
| H6 | Recognition rather than recall | Can you see the options you need, or do you have to remember where things are or what a field meant? |
| H7 | Flexibility and efficiency of use | Are frequent actions (mark read, mark done, filter by course) quick? Do the keyboard and search help? |
| H8 | Aesthetic and minimalist design | Does each screen show what matters first? Is anything there that doesn't help? |
| H9 | Help users recognize, diagnose and recover from errors | When something fails, does the message say what happened and what to do next, in plain words? |
| H10 | Help and documentation | When you are unsure, is there an explanation where you need it, for example on the Today plan or the timeline? |

## Severity

Give each problem one rating. Weigh three things: how often it happens, how badly it affects the task, and
whether users can work around it once they know.

| Rating | Meaning |
|---|---|
| 0 | Not a usability problem; I disagree that it is one. |
| 1 | Cosmetic only. Fix if there is time. |
| 2 | Minor. Low priority. |
| 3 | Major. Important to fix; high priority. |
| 4 | Catastrophe. Must be fixed before release. |

## Tasks

Do these in order on a fresh demo. Write down problems as you go, including ones you worked around. You may skip
a task that is blocked; record why.

1. **What's due.** From the first screen, find what is due today and what is overdue. Which course has the
   overdue item? Then pick something due later this week that is not on today's plan, and start it today.
2. **What changed.** Find the change to Quiz 10. What was the old time, and what is the new one? Then find out
   which file was added most recently.
3. **Catch up.** Mark every change in MATH 241 as read. Then mark one change as unread again.
4. **Record progress.** Problem Set 9 is overdue. Record that it is half done and that the rest will take about
   90 minutes.
5. **Your own task.** Add a personal task to MATH 241: "Review chapter 15", due the day after tomorrow at
   8 pm, estimated at one hour. Then change its due time to 6 pm.
6. **Plan the week.**
   - Add a study block tomorrow from 2 pm to 4 pm.
   - Find the Engineering career fair.
   - Use the timeline to find the busiest day of the next two weeks.
7. **Find a file.** Find the PHYS 212 lab handout and try to download it.
8. **Change the plan.** Set the daily study goal to 4 hours and the study window to 10 am–8 pm. Check how Today
   changes.
9. **Tidy up.** Archive RHET 105, check where its tasks went, then bring the course back.
10. **Sync.** Sync with Canvas and find out what the sync did.
11. **Finish.** Do these on the phone width if you haven't already. Then end the demo.

After the tasks, spend 15–20 minutes looking around freely, at both widths.

## Individual recording form

Copy this into your own file or sheet. Do not edit this page while round 1 is running.

```text
Evaluator:            (initials)
Role on the team:     (or "outside the team")
Built any of these screens? yes / no (which)
Date and start time:
Device and browser:
Widths used:          desktop ___ px, phone ___ px
Time spent:
```

| ID | Task (or "free") | Page and width | What happened | Heuristic | Severity 0–4 | Suggestion | Screenshot |
|---|---|---|---|---|---|---|---|
| E?-01 | | | | | | | |
| E?-02 | | | | | | | |

- Write one problem per row, even if two problems are on the same screen.
- In "What happened", describe what you did, what you expected and what you saw.
- If a problem breaks several heuristics, list the main one first.

## Merging (after every evaluator has finished)

The PM/UX lead merges the individual forms:

1. Put all rows together. Group rows that describe the same underlying problem, even if they are worded
   differently or found on different screens.
2. For each group, keep every evaluator's own severity and record the mean.
3. Every finding, including severity 0 and 1, gets a decision:
   - **fix in week 5**;
   - **later**;
   - **won't fix**, with a reason.
4. Fixes reference their commit. Round 2 checks each fixed row and records the result.

### Round 1: merged findings

Not run yet.

| # | Problem | Heuristic(s) | Found by | Severities | Mean | Where (page, width) | Decision | Fix (commit) | Round 2 |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

### Round 1: summary

Not run yet. Fill this in from the merged table:

- the number of evaluators;
- the number of distinct problems;
- how many problems have a mean severity of 3 or more;
- the problems more than one evaluator found.

## Revision and round 2 (week 5)

Not started. For each fixed problem, record:

- the merged finding number;
- before and after screenshots at the width where it was found;
- what changed and in which commit;
- whether round 2 evaluators consider it fixed. If not, give the new severity.
