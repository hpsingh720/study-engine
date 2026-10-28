package com.hpsingh720.studyengine;

import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;

/**
 * The swipe-down tile. One tap starts a lecture recording; tapping again stops it.
 *
 * The tile runs with no web page loaded, so it cannot read the class roster out of IndexedDB.
 * Instead the web app mirrors the next fortnight's classes into SharedPreferences whenever the
 * roster changes, and the tile picks whichever class covers the current time. If nothing matches,
 * the recording is named after the clock and can be renamed in the app afterwards.
 */
public class RecordTileService extends TileService {

    static final String PREFS = "study_engine_schedule";
    static final String KEY_CLASSES = "classes";

    @Override
    public void onStartListening() {
        super.onStartListening();
        paint();
    }

    @Override
    public void onClick() {
        super.onClick();

        if (RecorderService.isRunning()) {
            startService(new Intent(this, RecorderService.class).setAction(RecorderService.ACTION_STOP));
            paint();
            return;
        }

        Intent i = new Intent(this, RecorderService.class)
                .setAction(RecorderService.ACTION_START)
                .putExtra(RecorderService.EXTRA_CHUNK_SECONDS, 120)
                .putExtra(RecorderService.EXTRA_LABEL, labelForNow());

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
        else startService(i);

        paint();
    }

    /** The class on the roster covering right now, else the next one today, else the time. */
    private String labelForNow() {
        try {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            String raw = p.getString(KEY_CLASSES, "");
            if (raw.isEmpty()) return clockLabel();

            Calendar c = Calendar.getInstance();
            String today = String.format(Locale.US, "%04d-%02d-%02d",
                    c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
            String now = String.format(Locale.US, "%02d:%02d",
                    c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE));

            JSONArray arr = new JSONArray(raw);
            String next = null;

            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (!today.equals(o.optString("date"))) continue;
                String start = o.optString("start"), end = o.optString("end"), topic = o.optString("topic");
                if (topic.isEmpty()) continue;
                if (start.compareTo(now) <= 0 && end.compareTo(now) >= 0) return topic; // happening now
                if (start.compareTo(now) >= 0 && (next == null || start.compareTo(next) < 0)) next = topic;
            }
            return next != null ? next : clockLabel();
        } catch (Exception e) {
            return clockLabel();
        }
    }

    private String clockLabel() {
        Calendar c = Calendar.getInstance();
        int h = c.get(Calendar.HOUR_OF_DAY);
        int h12 = h % 12 == 0 ? 12 : h % 12;
        return "Lecture " + h12 + (h >= 12 ? "pm" : "am");
    }

    private void paint() {
        Tile t = getQsTile();
        if (t == null) return;
        boolean on = RecorderService.isRunning();
        t.setState(on ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        t.setLabel(on ? "Recording" : "Record lecture");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            t.setSubtitle(on ? "Tap to stop" : "Lecture");
        }
        try {
            t.setIcon(Icon.createWithResource(this, on
                    ? android.R.drawable.presence_audio_online
                    : android.R.drawable.ic_btn_speak_now));
        } catch (Exception ignored) {}
        t.updateTile();
    }
}
