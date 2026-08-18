# Putting Poker Party online permanently (free)

This hosts the game on **Render** so it runs 24/7 with a permanent link — no need to
keep your PC on. Render's free plan costs nothing and needs no credit card.

**One heads-up about "free":** a free Render service **goes to sleep after 15 minutes
with nobody on it.** The next person to open the link wakes it up, which takes about a
minute (they'll see it load slowly, then it's fine). If you want it to *never* sleep,
that's a small paid upgrade — see the last section.

---

## Step 1 — Put the game on GitHub

You need the game's files in a GitHub repository so Render can read them. If you'd like,
I (Claude) can do this whole step for you — just say "push it to GitHub" and I'll create
a new repo called **poker-party** on your account and upload the files. Otherwise:

1. Go to https://github.com/new and create a repository named `poker-party` (Public is fine).
2. Upload all the files from your `Texas Holdem` folder to it (GitHub's website has an
   "uploading an existing file" drag-and-drop, or use GitHub Desktop).

## Step 2 — Deploy on Render

1. Go to https://render.com and sign up (you can use "Sign in with GitHub" — quickest).
2. Click **New +** → **Blueprint**.
3. Choose your `poker-party` repository. Render reads the included `render.yaml` and fills
   everything in automatically. Click **Apply** / **Create**.
4. Wait ~2–3 minutes for the first build. When it's done you'll get a permanent URL like
   `https://poker-party-xxxx.onrender.com`.

## Step 3 — Set your room code

So random people can't wander in, set a join code:

1. In Render, open your **poker-party** service → **Environment** tab.
2. Add an environment variable:
   - **Key:** `POKER_ROOM_CODE`
   - **Value:** anything you like, e.g. `TABLE7` (players type this to join)
3. Save. Render redeploys automatically.

Now share **two things** with friends: the `onrender.com` link and the room code.
They open the link on any phone or computer, type a name and the code, and play.

---

## Playing

- The permanent link always works — you don't run anything on your PC.
- You play at the same link too, just like everyone else.
- Everyone starts with the same chips; any player can pick the bots/difficulty and start,
  and any player can deal the next hand.

## If you want it to never sleep (optional, paid)

On the free plan the game sleeps after 15 minutes idle and takes ~1 minute to wake.
To keep it instant 24/7, in Render open the service → **Settings** → change the
**Instance Type** from **Free** to **Starter** (a few dollars a month). Nothing else changes.

## Updating the game later

If I make changes to the game, they go live automatically: the files get pushed to your
GitHub repo and Render redeploys within a couple of minutes (that's what `autoDeploy` in
`render.yaml` does).
