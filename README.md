# FFY Web Giveaway

Your very own giveaway website. Viewers pop over, log in with Twitch and spend their points on tickets, even when you're offline, asleep or on holiday. Then you draw the winner live on stream with confetti.

- **Open all the time.** Run a giveaway for a day, a week or a month, and people can enter whenever suits them.
- **Points earn themselves.** Everyone in your chat gets points every few minutes while you're live. Already use FFY Points in Streamer.bot? Use those instead.
- **Your control page** starts giveaways, sets a draw date, shows who's in, and draws, redraws or cancels with everyone's points refunded. It works on your phone too.
- **Chat knows what's going on.** Messages go out when a giveaway starts and when someone wins, and for every entry too if you like.
- **A winner overlay** for OBS, with confetti and their chance of winning.
- **Make it yours:** your banner, profile picture, background, colours, and your own name and icon for points.
- **Your own web address.** Got a domain? Point something like `giveaway.yoursite.com` at it instead of the GitHub address. The [setup guide](SETUP.md#using-your-own-domain-optional) shows you how.

It's completely free. Everything runs on your own GitHub Pages and your own free Supabase project, so nobody else holds your viewers' points.

### 👉 [Set it up](SETUP.md)

About 15 minutes, no coding, just copying and pasting.

---

## What's in here

You don't need to touch any of this yourself. The setup guide tells you what to copy where.

| Folder | What it is |
|---|---|
| `docs/` | The website itself: the page viewers see, your control page, the OBS overlay, the setup helper, and a Points Builder for FFY Points with the link to your site. GitHub Pages shows this folder. |
| `supabase/setup.sql` | The database. You run it once in Supabase. |
| `supabase/functions/web-giveaway/` | The bit that runs behind the scenes. You paste it into Supabase. |
