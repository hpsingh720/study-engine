package com.hpsingh720.studyengine;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.service.quicksettings.TileService;
import android.widget.Toast;

/**
 * An invisible screen the swipe-down tile opens for a moment.
 *
 * Since Android 14 an app may only switch the microphone on while it is in front of the user. The
 * tile used to start the recorder straight from the background, which Android now refuses, so the
 * tile appeared to do nothing until the app had been opened by hand. Starting it from here, for the
 * split second this screen is showing, is what Android allows. It also gives the app somewhere to
 * ask for microphone permission, which the tile on its own cannot do.
 */
public class TileTapActivity extends Activity {
    static final String EXTRA_LABEL = "label";
    private static final int ASK_MIC = 7101;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (RecorderService.isRunning()) {
            startService(new Intent(this, RecorderService.class).setAction(RecorderService.ACTION_STOP));
            done();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, ASK_MIC);
            return;
        }
        record();
        done();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == ASK_MIC) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) record();
            else Toast.makeText(this, "Study Engine needs the microphone to record lectures.", Toast.LENGTH_LONG).show();
        }
        done();
    }

    private void record() {
        String label = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_LABEL);
        Intent i = new Intent(this, RecorderService.class)
                .setAction(RecorderService.ACTION_START)
                .putExtra(RecorderService.EXTRA_CHUNK_SECONDS, 120)
                .putExtra(RecorderService.EXTRA_LABEL, label == null ? "" : label);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
            else startService(i);
        } catch (Exception e) {
            Toast.makeText(this, "Could not start recording: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void done() {
        // Ask the tile to redraw, so it shows Recording / Record lecture correctly next time.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try { TileService.requestListeningState(this, new ComponentName(this, RecordTileService.class)); } catch (Exception ignored) {}
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
