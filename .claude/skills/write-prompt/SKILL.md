---
name: write-prompt
description: >-
  Write, draft, improve, or critique a prompt for an LLM / AI assistant. Use
  when the user asks to "write a prompt", "improve this prompt", "make a power
  prompt", "turn this into a good prompt", or when you are about to hand a task
  to another model and want a well-structured instruction. Distilled from
  Google's "Gemini for Workspace — Prompting 101" guide.
---

# Writing effective prompts

A prompt is a conversation starter with an AI assistant. The goal of this skill
is to turn a vague ask into a clear, specific, well-structured instruction — and
to iterate when the first result misses.

The single most important rule: **every prompt must contain a verb/command** —
the task. Everything else sharpens it.

## The PTCF framework

Build a prompt from up to four parts. You don't need all four every time, but
using several sharply improves results.

| Part | Question it answers | Example fragment |
|---|---|---|
| **Persona** | Who should the AI act as? | "You are a program manager in fintech…" |
| **Task** | What exactly should it do? (the verb — **required**) | "Draft an executive summary email…" |
| **Context** | What background/inputs matter? | "…based on the attached Q3 program docs…" |
| **Format** | What shape should the output take? | "Limit to bullet points." |

**Worked example (all four):**
> *You are a program manager in [industry]. Draft an executive summary email to
> [persona] based on [details about relevant program docs]. Limit to bullet
> points.*

## Core principles

1. **Use natural language.** Write in full sentences, as if speaking to a
   capable colleague. Express complete thoughts.
2. **Be specific, then iterate.** Say precisely what you want (summarize / write
   / rewrite / classify / extract / create) and give as much relevant context as
   possible.
3. **Be concise; avoid jargon.** Brief but specific. Cut filler, not detail.
4. **Make it a conversation.** Treat the first output as a draft. Refine with
   follow-up prompts rather than trying to nail it in one shot.
5. **Provide the inputs.** When the prompt depends on a document, data, or prior
   text, supply or reference it explicitly instead of assuming the model has it.

**Length heuristic:** the most effective prompts average **~21 words** with
relevant context. People's first attempts are usually under 9 words — too thin.
If your draft is very short, you are almost certainly missing context or format.

## Leveling-up techniques

Apply these when a plain PTCF prompt isn't enough:

- **Break it up.** Several related tasks → several prompts, in sequence. One
  prompt per coherent step beats one overloaded prompt.
- **Give constraints.** Pin down the output: character/word limits, number of
  options, required sections, columns of a table, allowed/forbidden items.
- **Assign a role.** Open with "You are a [specific expert]…" to steer tone and
  raise the quality/creativity ceiling.
- **Ask the model for feedback.** For open-ended work, hand it the project +
  details + desired output, then ask: *"What questions do you have for me that
  would help you produce the best result?"* — answer those, then proceed.
- **Set the tone.** Name the audience and the register: formal, casual,
  technical, creative, etc.
- **Say it another way.** If results miss, rephrase rather than repeat. Small
  wording changes often unlock better output.

## Workflow for this skill

When asked to write or improve a prompt:

1. **Identify the task verb.** If the user's request has no clear action, ask
   what outcome they want before writing anything.
2. **Fill the PTCF slots.** Add Persona, Context, and Format where they help.
   Leave `[bracketed placeholders]` for details only the user has (names, files,
   numbers, dates).
3. **Add constraints and tone** from the leveling-up list as the task warrants.
4. **Check the length heuristic.** If under ~15 words and not trivially simple,
   you're probably missing context or format — add it.
5. **Decide single vs. multi-step.** If the ask bundles several tasks, split
   into a numbered sequence of prompts.
6. **Deliver the prompt, then offer to iterate.** Present the prompt in a copy-
   pasteable block; note which placeholders to fill; offer a refinement path.

## "Make this a power prompt" mode

If the user gives an existing weak prompt (or says *"make this a power
prompt: …"*), don't just rewrite silently:

1. Name what's missing against PTCF (e.g., "no persona, no format constraint").
2. Produce an upgraded version with the gaps filled and placeholders marked.
3. Briefly say what you changed and why, so the user can adjust.

## Output template

```
You are [persona].
[Task — start with a verb: draft / summarize / rewrite / analyze / create …]
[Context — relevant background, or @reference the file/data].
[Format — length, structure, tone, number of options].
```

## Before delivering — quality bar

- Does it contain a clear **task verb**? (non-negotiable)
- Are vague terms replaced with specifics or bracketed placeholders?
- Are output **format and constraints** stated?
- Is it natural-language, jargon-free, and roughly ≥15 words when non-trivial?
- For multi-part asks: is it split into separate steps?

## Honest note

Generative AI output is a starting point, not a final answer. Always tell the
user to review the result for **clarity, relevance, and accuracy** before acting
on it — the final output is theirs.
