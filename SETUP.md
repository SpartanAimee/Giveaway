# Setting up your FFY Web Giveaway

Your own giveaway page where viewers spend points on tickets, even while you're offline. Free, about 15 minutes, and you only do it once.

You'll need free accounts on **GitHub** and **Supabase**, plus your Twitch. Keep a notepad handy for the bits marked 📝.

### 👉 [Open the setup helper](https://flufffaceyeti.github.io/FFYGiveaway/setup.html?new)
Keep it open in another tab. Do steps 1 to 3 below, then the helper does the rest with copy buttons.

---

### 1. Get your copy
Click **[Make my own copy](https://github.com/new?template_name=FFYGiveaway&template_owner=FluffFaceYeti)**. Name it `giveaway`, set it to **Public**, and click **Create repository**.

### 2. Turn it into a website
In your copy, go to **Settings > Pages** and choose **Deploy from a branch**, **main** and **/docs**, then **Save**. After a minute it shows your 📝 **site address**, like `https://yourname.github.io/giveaway/`. Capitals matter.

### 3. Make a Supabase project
On [supabase.com](https://supabase.com), click **New project**. When it's ready, copy your 📝 **Supabase address** from **Project Settings > API > Project URL** (it ends in `.supabase.co`).

### 4. Open the setup helper
Open the **[setup helper](https://flufffaceyeti.github.io/FFYGiveaway/setup.html?new)** and fill in your details. Your own copy has it too, at your site address + `setup.html`. It writes everything else for you, with copy buttons and links. Just work down its boxes:

1. **Database:** copy the code, open the SQL editor, paste and click **Run**.
2. **Twitch app:** at [dev.twitch.tv/console](https://dev.twitch.tv/console), register an app with the redirect URLs it gives you. Put the 📝 **Client ID** into the helper, then click **New Secret** and keep the 📝 **Client Secret** private.
3. **config.js:** copy it, open it on GitHub, replace everything and click **Commit changes**.
4. **Function:** make a new Edge Function and, **before you deploy it**, change its name to `web-giveaway`. Supabase gives it a random name like `quick-processor`, and renaming it afterwards doesn't change its address. Paste the code in, deploy it, then turn **off Verify JWT**. Don't skip that bit.
5. **Secrets:** add the three it lists. You paste the Client Secret in yourself.

### 5. Open your control page 🎉
Go to your site address + `control.html` and log in with Twitch. Click **Connect Twitch**, then **Test chat**.

Under **Points**, choose where points come from:
- **Streamer.bot:** copy the link and open the Points Builder from the control page (it's your site address + `points-builder.html`). Paste the link into **Web Giveaway link**, make the import and import it into Streamer.bot. Use this builder, not the normal FFY Points one, because only this one has the link. Your points are kept.
- **This website:** if you don't use Streamer.bot.

Click **Save**.

### 6. Add the overlay to OBS
Copy the overlay link and add it as a **Browser Source** at 1920×1080. It's invisible until someone wins, so click **Show a test winner** to check it.

### 7. Go!
Set your look, start a giveaway, and share your site address. Draw the winner from the control page whenever you're ready, and your phone works too.

---

### Using your own domain (optional)
Add a **CNAME** record named `giveaway` pointing to `yourname.github.io`. Then put `giveaway.yourname.com` in **Settings > Pages > Custom domain** and tick **Enforce HTTPS** once it's ready. Put the domain into the setup helper and add the extra redirect URL it shows to your Twitch app.

### Stuck?
- **"Almost there":** finish the setup helper (step 4). After committing config.js, give GitHub a minute.
- **"There isn't a GitHub Pages site here":** check the capitals and the /docs setting, or wait a minute.
- **"Supabase is blocking the giveaway":** turn off Verify JWT (step 4).
- **"redirect_mismatch" or "redirect_uri does not match":** your Twitch redirect URLs must match exactly. If it happens when you click **Connect Twitch**, the Supabase one (ending `/functions/v1/web-giveaway`) is missing. Click **Save** at the bottom of the Twitch page after adding it.
- **"Requested function was not found":** the function's address doesn't end in `/web-giveaway`. Make it again and name it before deploying (step 4).
- **Still showing an old error after fixing something:** press **Ctrl + F5**. Your browser can hang on to old settings for up to 10 minutes.
- **"Twitch login failed":** make a new secret and paste it into Supabase again.
- **Overlay is empty:** that's normal until a winner is drawn.
- **Page can't reach the server:** free Supabase projects nap after a week. Open it and click **Restore**.

Still stuck? Send FluffFaceYeti a screenshot.

### Updating
Copy the new files into your copy, but keep your own `config.js`. If the update says so, redeploy `index.ts` or run `setup.sql` again (always safe).
