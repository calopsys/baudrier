# /start

Prepares your Claude Code web environment so it can build applications with Baudrier.

## When to use it

This is the **very first command** to run right after opening a fresh "Baudrier" cloud environment on Claude Code web (claude.ai/code). It checks every prerequisite and walks you through any missing Scaleway setup. You should only have to run it once per environment.

## How it works

1. **Environment guard**: the command checks it is really running on Claude Code web. Baudrier has no local install path any more - on any other kind of session, it stops immediately and points you at the README's Installation chapter instead of half-running.
2. **Internal dependencies**: Baudrier checks the libraries it uses to talk to your hosting provider. The cloud environment's own Setup script normally installs them when the environment is built, so a failure here means a real repair is needed - Baudrier replays that script for you.
3. **Repo access**: confirms this session can reach the GitHub repository it was opened on.
4. **Signing your code**: Git will not create a single record of your work until it knows who is signing it. Baudrier derives your name from the repository owner and proposes a GitHub forwarding address: your contributions stay linked to your account, but your personal address never appears in the public history. One confirmation, and it is settled for every project.
5. **Scaleway credentials and rights**: checks that the four required environment variables are present, validates them with a real API call, then checks whether your account can create Scaleway Projects. If it cannot, Baudrier explains the two ways forward: recreate the key yourself (organization admin), or point at an existing Project and let your administrator handle the rest (organization member).
6. **Network reachability**: confirms the environment's network access actually reaches the Scaleway API.
7. **Docker and tool audit**: confirms Docker answers and every tool the environment was supposed to install is genuinely ready. If not, Baudrier recommends rebuilding the cloud environment rather than patching tools one by one.
8. **Identity verification (optional)**: Baudrier explains why verifying your identity with Scaleway matters (higher email/storage/container limits) and offers to open the page - entirely optional, never blocking.
9. **Overview and conclusion**: a recap of what you can do next (`/bootstrap`, `/prof`, etc.).

## What it creates for you

- Baudrier's own internal libraries installed and verified
- Confirmed access to your GitHub repository
- A git signing identity, so every record of your work is attributed to you without exposing your personal address
- Confirmed Scaleway credentials, with a clear path forward if your account lacks organization-level rights
- Confirmed Docker and tool readiness in the cloud environment
- A list of the commands you can now use

## Prerequisites

A "Baudrier" cloud environment already created and running on Claude Code web, with the Scaleway environment variables set - see the README's Installation chapter (`README.md`).

{{callout:info|Why so few tools}}
This harness runs entirely on Scaleway: one hosting provider for everything (the app, the database, storage, email, the container registry, the secrets). The cloud environment's own Setup script preinstalls exactly what that requires - Node.js, Git, pnpm, and Docker. `/start` only ever needs to check them, plus your GitHub connection and Scaleway credentials.
{{/callout}}

{{callout:tip|If something goes wrong}}
No problem: simply re-run `/start`. The command detects what is already OK and resumes where it left off. No risk of breaking anything.
{{/callout}}

{{callout:info|Installing on Claude Code web}}
The full step-by-step guide is the Installation chapter of the README (`README.md`): creating your Scaleway API key, connecting GitHub, and creating the "Baudrier" cloud environment.
{{/callout}}
