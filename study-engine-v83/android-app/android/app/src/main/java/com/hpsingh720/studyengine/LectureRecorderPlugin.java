package com.hpsingh720.studyengine;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.io.File;
import java.util.Locale;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;

/**
 * Bridge between the web app and RecorderService.
 *
 * The service outlives any single web page, so the listener list is held statically: a page reload
 * mid-lecture re-registers and keeps receiving chunks instead of losing the recording.
 */
@CapacitorPlugin(
    name = "LectureRecorder",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class LectureRecorderPlugin extends Plugin {

    private static LectureRecorderPlugin instance;

    // Chunks that finished while no page was listening, so nothing is lost across a reload.
    private static final java.util.List<JSObject> pending = new java.util.ArrayList<>();

    @Override
    public void load() {
        instance = this;
        super.load();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) { try { tts.shutdown(); } catch (Exception ignored) {} tts = null; ttsReady = false; }
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicPermission");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void afterMicPermission(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission was declined");
            return;
        }
        launch(call);
    }

    private void launch(PluginCall call) {
        int seconds = call.getInt("chunkSeconds", 120);
        String label = call.getString("label", "Lecture");

        Intent i = new Intent(getContext(), RecorderService.class)
                .setAction(RecorderService.ACTION_START)
                .putExtra(RecorderService.EXTRA_CHUNK_SECONDS, seconds)
                .putExtra(RecorderService.EXTRA_LABEL, label);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(i);
        } else {
            getContext().startService(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), RecorderService.class).setAction(RecorderService.ACTION_STOP);
        getContext().startService(i);
        call.resolve();
    }

    /** Hand a finished chunk to JavaScript as base64 so it can be posted straight to the transcriber. */
    @PluginMethod
    public void readChunk(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("No path given"); return; }
        File f = new File(path);
        if (!f.exists()) { call.reject("That recording is no longer on the device"); return; }

        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            r.put("mime", path.endsWith(".ogg") ? "audio/ogg" : "audio/mp4");
            r.put("bytes", f.length());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read the recording: " + e.getMessage());
        }
    }

    /** Called once a chunk has been transcribed; audio is large and there is no reason to keep it. */
    @PluginMethod
    public void deleteChunk(PluginCall call) {
        String path = call.getString("path");
        if (path != null) { try { new File(path).delete(); } catch (Exception ignored) {} }
        call.resolve();
    }

    /**
     * Every recorded piece still on the phone. A piece is deleted only after it has been turned into
     * text, so anything listed here is a part of a lecture the page has not got yet — the class
     * recorded from the tile while the app was closed, or a part whose transcription failed.
     * The list of finished pieces kept in memory is lost when Android closes the app; the files are not.
     */
    @PluginMethod
    public void listChunks(PluginCall call) {
        JSObject r = new JSObject();
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        File dir = new File(getContext().getFilesDir(), "lectures");
        File[] files = dir.listFiles();
        String active = RecorderService.activePath;
        long now = System.currentTimeMillis();
        if (files != null) {
            for (File f : files) {
                String name = f.getName();
                if (!name.startsWith("chunk_")) continue;
                if (active != null && active.equals(f.getAbsolutePath())) continue;
                if (now - f.lastModified() < 15000) continue;   // still being written
                JSObject o = new JSObject();
                o.put("path", f.getAbsolutePath());
                o.put("size", f.length());
                o.put("mtime", f.lastModified());
                arr.put(o);
            }
        }
        r.put("chunks", arr);
        call.resolve(r);
    }

    /** Chunks that finished while the page was away (reload, or the user left the app). */
    @PluginMethod
    public void drainPending(PluginCall call) {
        JSObject r = new JSObject();
        synchronized (pending) {
            r.put("chunks", new com.getcapacitor.JSArray(pending));
            pending.clear();
        }
        call.resolve(r);
    }

    /**
     * Whether a lecture is being recorded right now.
     *
     * The web page needs this because the Quick Settings tile can start a recording with no page
     * loaded at all — on opening the app it must adopt that recording rather than show an idle
     * Start button over a running microphone.
     */
    @PluginMethod
    public void getState(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", true);
        r.put("recording", RecorderService.isRunning());
        r.put("label", RecorderService.runningLabel());
        r.put("startedAt", RecorderService.runningSince());
        call.resolve(r);
    }

    /**
     * Mirror the upcoming classes so the tile can name a recording without the web app running.
     * Stored as plain JSON: date, start, end, topic.
     */
    @PluginMethod
    public void setSchedule(PluginCall call) {
        try {
            com.getcapacitor.JSArray classes = call.getArray("classes");
            getContext()
                .getSharedPreferences(RecordTileService.PREFS, android.content.Context.MODE_PRIVATE)
                .edit()
                .putString(RecordTileService.KEY_CLASSES, classes == null ? "" : classes.toString())
                .apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not save the schedule: " + e.getMessage());
        }
    }

    // ---- the phone's own voice, for the voice quiz and the patient in the case simulator ----
    // The app's web view has no speech of its own, so speaking goes through Android's TextToSpeech.

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final java.util.Map<String, PluginCall> speaking = new java.util.HashMap<>();

    private void withTts(Runnable then, PluginCall call) {
        if (tts != null && ttsReady) { then.run(); return; }
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (!ttsReady) { call.reject("The phone has no text-to-speech voice installed."); return; }
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) { PluginCall c; synchronized (speaking) { c = speaking.remove(id); } if (c != null) c.resolve(); }
                @Override public void onError(String id) { PluginCall c; synchronized (speaking) { c = speaking.remove(id); } if (c != null) c.resolve(); }
            });
            then.run();
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        final String text = call.getString("text", "");
        final String lang = call.getString("lang", "en-IN");
        final float rate = call.getFloat("rate", 1.0f);
        final float pitch = call.getFloat("pitch", 1.0f);
        if (text == null || text.isEmpty()) { call.resolve(); return; }
        call.setKeepAlive(true);
        withTts(() -> {
            Locale loc = Locale.forLanguageTag(lang);
            if (tts.isLanguageAvailable(loc) < TextToSpeech.LANG_AVAILABLE) {
                // Punjabi or Hindi read out by the English voice is gibberish, so say so instead.
                if (!lang.startsWith("en")) { call.reject("nolang " + lang, "nolang"); return; }
                loc = Locale.forLanguageTag("en-IN");
            }
            tts.setLanguage(loc);
            tts.setSpeechRate(rate);
            // A lower pitch for a man's voice; the phone's voices are mostly female.
            tts.setPitch(pitch);
            String id = "u" + System.nanoTime();
            synchronized (speaking) { speaking.put(id, call); }
            int r = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
            if (r != TextToSpeech.SUCCESS) { synchronized (speaking) { speaking.remove(id); } call.reject("Could not speak"); }
        }, call);
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null) tts.stop();
        synchronized (speaking) { for (PluginCall c : speaking.values()) c.resolve(); speaking.clear(); }
        call.resolve();
    }

    /** Ask for the microphone before the web page listens (voice quiz, case history). */
    @PluginMethod
    public void ensureMic(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject r = new JSObject(); r.put("granted", true); call.resolve(r); return;
        }
        requestPermissionForAlias("microphone", call, "afterEnsureMic");
    }

    @PermissionCallback
    private void afterEnsureMic(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("microphone") == PermissionState.GRANTED);
        call.resolve(r);
    }

    static void emitChunk(String path, int index, boolean last) {
        JSObject d = new JSObject();
        d.put("path", path);
        d.put("index", index);
        d.put("last", last);
        if (instance != null) {
            instance.notifyListeners("chunk", d, true);
        } else {
            synchronized (pending) { pending.add(d); }
        }
    }

    static void emitState(boolean recording, String label, long startedAt) {
        if (instance == null) return;
        JSObject d = new JSObject();
        d.put("recording", recording);
        d.put("label", label);
        d.put("startedAt", startedAt);
        instance.notifyListeners("state", d, true);
    }

    static void emitError(String message) {
        if (instance == null) return;
        JSObject d = new JSObject();
        d.put("message", message);
        instance.notifyListeners("recorderError", d, true);
    }
}
