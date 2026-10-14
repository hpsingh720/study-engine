# Clinical Study Engine: setup (about 30 minutes, all free)

## 1. Put the app online (GitHub Pages)
1. Sign in to github.com, click **New repository**, name it `study-engine`, make it **Public**, and create it.
2. Click **uploading an existing file**. Unzip this folder, drag **everything inside it** (index.html, styles.css, the js folder, icons, sw.js, manifest) into the page, then click **Commit**.
3. Go to **Settings → Pages**. Under Source, pick **Deploy from a branch**, then **main / root**, and **Save**.
4. After a minute your app is at `https://<your-username>.github.io/study-engine/`.

Your books are never uploaded to GitHub. Only the app's code goes there.

## 2. Gemini key (laptop only)
1. Go to aistudio.google.com, click **Get API key**, then **Create API key**.
2. In the app, open **Settings** and paste the key. Click **Test key & list models**.
3. The default model is `gemini-2.5-flash`. If the list shows a newer Flash or Pro model, you can pick it.

The free key has daily limits, and your Gemini app subscription doesn't raise them. When the limit is hit, the app pauses and carries on by itself later. Turning on billing for the key removes the limits.

## 3. Sync (so the phone and iPad get everything)
1. At supabase.com, create a free account and click **New project**.
2. In the app, open **Settings → Copy setup script**. In Supabase, open **SQL Editor**, paste the script and click **Run**.
3. In Supabase, open **Project settings → API** and copy the **Project URL** and the **anon public** key.
4. Paste both into **Settings → Sync** on the laptop, the iPad and the phone.

Keep the URL and key private. Anyone who has both can read your study data.

## 4. Load all the books (laptop, Chrome or Edge)
1. Open the app and go to **Library**. Drag in every PDF at once, plus photos of AMEDEX screens.
2. Check each book's type in the dropdown:
   - **Reference / MBBS / AMC books** become the three columns of every topic sheet.
   - **MCQ books and question banks** are split into questions, sorted by topic.
   - **Practical books** become image spotter questions.
3. Click **Add and start processing**, then **Generate every topic**.
4. Leave the tab open. It keeps the laptop awake and works through the list, starting with the system you've set under "Up next" on the Today page.

## 5. Install on the S24 Ultra and iPad
- **Phone (Chrome):** open the link, tap **⋮**, then **Add to Home screen**.
- **iPad (Safari):** open the link, tap **Share**, then **Add to Home Screen**.
- Enter the same Sync details in Settings on each device.

## Daily flow
1. Read the topic from your physical notes.
2. Open the topic and tap **I've finished this topic → test me**. The AMC changes stay on the left and the questions on the right.
3. Do the **biweekly test** when the Today page says it's due.
4. Write with the pencil or add photos under **Notes**. Ask doubts under **Ask AI**.

## If something goes wrong
- **A page reads "general knowledge":** your books didn't cover that point, so the AI filled it in from what it knows. Open the topic's **⋯** menu, choose **Rename / edit search words**, add the words your books use for it, then choose **Rewrite sheet from books**.
- **A question is wrong:** tap **Flag bad question** and it won't come back.
- **Backup:** go to **Progress → Download backup** now and then.
