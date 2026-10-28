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

import java.io.File;
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

    @PluginMethod
    public void isRecording(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", true);
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
