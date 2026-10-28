# Study Engine — Android shell

This folder builds the Android app. It is deliberately thin.

The app does **not** contain the study engine. It opens
`https://hpsingh720.github.io/study-engine/` in a full-screen view and adds the two things a web
page cannot do on Android:

1. **Lecture recording that survives a locked screen** — a foreground service holding the
   microphone, writing audio in 2-minute chunks.
2. **Local notifications** — the 9pm reminder for the next day's classes.

Because the web app is loaded from GitHub Pages, every change you make to the site is live in the
app the next time it opens. **You do not rebuild the APK when you change the website.** You only
rebuild it if something in this folder changes.

---

## Getting the APK (no laptop needed)

1. Go to the repo on GitHub → **Actions** tab
2. Pick **Build Android APK** in the left-hand list
3. Press **Run workflow** → **Run workflow**
4. Wait about 5 minutes
5. Open the finished run and scroll to **Artifacts** at the bottom
6. Download **study-engine-apk**, unzip it, tap `app-debug.apk` to install

Android will warn about installing from an unknown source — allow it for your browser or Files app.

The APK is unsigned-for-release (a debug build). That is fine for your own phone. It cannot go on
the Play Store as-is.

---

## After installing

Grant these when asked, or the features silently do nothing:

- **Microphone** — asked the first time you record
- **Notifications** — asked the first time a roster is saved
- **Battery: unrestricted** — Settings → Apps → Study Engine → Battery. Samsung's power saving will
  otherwise kill a long recording. This is the single most common cause of a lecture cutting out.

---

## Files that matter

| File | What it does |
|---|---|
| `capacitor.config.json` | Points the app at the live site. Change `server.url` if the site moves. |
| `android/app/src/main/java/.../RecorderService.java` | The foreground service. Chunk length, audio format, wake lock. |
| `android/app/src/main/java/.../LectureRecorderPlugin.java` | Passes chunks to the web page. |
| `android/app/src/main/AndroidManifest.xml` | Permissions and the service declaration. |
| `../.github/workflows/android.yml` | The build that runs on GitHub. |

## Building locally instead (optional)

Only if you have Android Studio:

```
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/`.
