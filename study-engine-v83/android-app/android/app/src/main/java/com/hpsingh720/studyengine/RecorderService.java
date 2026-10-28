package com.hpsingh720.studyengine;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.io.File;

/**
 * Keeps recording while the screen is off and the app is in the background.
 *
 * Audio is written in fixed-length chunks rather than one long file, so the web layer can start
 * transcribing minute two while minute three is still being spoken. Each finished chunk is handed
 * to LectureRecorderPlugin, which forwards it to JavaScript.
 *
 * Rotating chunks means stopping one MediaRecorder and starting the next, which drops roughly
 * 20-50ms of audio at each boundary. For speech that is a syllable at worst; the alternative
 * (two interleaved recorders) costs far more complexity than it buys.
 */
public class RecorderService extends Service {

    public static final String ACTION_START = "com.hpsingh720.studyengine.START";
    public static final String ACTION_STOP = "com.hpsingh720.studyengine.STOP";
    public static final String EXTRA_CHUNK_SECONDS = "chunkSeconds";
    public static final String EXTRA_LABEL = "label";

    private static final String TAG = "RecorderService";
    private static final String CHANNEL_ID = "lecture_recording";
    private static final int NOTIFICATION_ID = 4701;

    private MediaRecorder recorder;
    private File currentFile;
    private int chunkIndex = 0;
    private int chunkSeconds = 120;
    private String label = "Lecture";
    private long startedAt = 0L;
    private boolean running = false;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;

    private final Runnable rotate = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            rotateChunk();
            handler.postDelayed(this, chunkSeconds * 1000L);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            stopRecording();
            stopSelf();
            return START_NOT_STICKY;
        }

        if (running) return START_STICKY;

        if (intent != null) {
            chunkSeconds = Math.max(30, intent.getIntExtra(EXTRA_CHUNK_SECONDS, 120));
            String l = intent.getStringExtra(EXTRA_LABEL);
            if (l != null && !l.isEmpty()) label = l;
        }

        createChannel();
        Notification n = buildNotification("Recording — " + label);

        // Android 10+ wants the service type declared at start time as well as in the manifest.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }

        acquireWakeLock();

        try {
            startNewChunk();
        } catch (Exception e) {
            Log.e(TAG, "could not start recording", e);
            LectureRecorderPlugin.emitError("Could not start the microphone: " + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }

        running = true;
        startedAt = System.currentTimeMillis();
        handler.postDelayed(rotate, chunkSeconds * 1000L);
        LectureRecorderPlugin.emitState(true, label, startedAt);
        return START_STICKY;
    }

    /** Close the current chunk, hand it over, and immediately open the next one. */
    private void rotateChunk() {
        File finished = currentFile;
        try {
            closeRecorder();
        } catch (Exception e) {
            Log.w(TAG, "recorder did not stop cleanly", e);
            finished = null;
        }

        if (finished != null && finished.exists() && finished.length() > 1024) {
            LectureRecorderPlugin.emitChunk(finished.getAbsolutePath(), chunkIndex, false);
        } else if (finished != null) {
            // A chunk under 1KB holds no usable audio; drop it rather than spend a transcription call.
            finished.delete();
        }

        try {
            startNewChunk();
        } catch (Exception e) {
            Log.e(TAG, "could not continue recording", e);
            LectureRecorderPlugin.emitError("Recording stopped unexpectedly: " + e.getMessage());
            stopRecording();
            stopSelf();
        }
    }

    private void startNewChunk() throws Exception {
        File dir = new File(getFilesDir(), "lectures");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("could not create the recordings folder");

        chunkIndex++;
        boolean opus = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        currentFile = new File(dir, "chunk_" + startedAtOrNow() + "_" + chunkIndex + (opus ? ".ogg" : ".m4a"));

        recorder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? new MediaRecorder(this)
                : new MediaRecorder();

        recorder.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION);
        if (opus) {
            recorder.setOutputFormat(MediaRecorder.OutputFormat.OGG);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.OPUS);
            recorder.setAudioEncodingBitRate(24000);
            recorder.setAudioSamplingRate(16000);
        } else {
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(32000);
            recorder.setAudioSamplingRate(16000);
        }
        recorder.setAudioChannels(1);
        recorder.setOutputFile(currentFile.getAbsolutePath());
        recorder.prepare();
        recorder.start();
    }

    private long startedAtOrNow() {
        return startedAt == 0L ? System.currentTimeMillis() : startedAt;
    }

    private void closeRecorder() {
        if (recorder == null) return;
        try {
            recorder.stop();
        } finally {
            try { recorder.reset(); } catch (Exception ignored) {}
            try { recorder.release(); } catch (Exception ignored) {}
            recorder = null;
        }
    }

    private void stopRecording() {
        if (!running) return;
        running = false;
        handler.removeCallbacks(rotate);

        File finished = currentFile;
        try {
            closeRecorder();
        } catch (Exception e) {
            Log.w(TAG, "recorder did not stop cleanly", e);
            finished = null;
        }

        if (finished != null && finished.exists() && finished.length() > 1024) {
            LectureRecorderPlugin.emitChunk(finished.getAbsolutePath(), chunkIndex, true);
        } else {
            if (finished != null) finished.delete();
            LectureRecorderPlugin.emitChunk(null, chunkIndex, true);
        }

        releaseWakeLock();
        LectureRecorderPlugin.emitState(false, label, startedAt);
        chunkIndex = 0;
        startedAt = 0L;
    }

    @Override
    public void onDestroy() {
        stopRecording();
        try { stopForeground(true); } catch (Exception ignored) {}
        super.onDestroy();
    }

    /**
     * Samsung's battery management is aggressive enough to pause a foreground service's thread on a
     * sleeping screen. A partial wake lock is the documented way to keep the CPU on while recording.
     */
    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "StudyEngine:lecture");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(4 * 60 * 60 * 1000L); // hard ceiling: 4 hours
        } catch (Exception e) {
            Log.w(TAG, "no wake lock", e);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {}
        wakeLock = null;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Lecture recording", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while a lecture is being recorded.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, flags);

        Intent stop = new Intent(this, RecorderService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(this, 1, stop, flags);

        return new androidx.core.app.NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Study Engine")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.presence_audio_online)
                .setOngoing(true)
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_LOW)
                .setContentIntent(tap)
                .addAction(android.R.drawable.ic_media_pause, "Stop", stopPending)
                .build();
    }
}
