package com.hpsingh720.studyengine;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {
    private static final int CAMERA_REQUEST = 4411;
    private PermissionRequest pendingWebRequest;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LectureRecorderPlugin.class);
        super.onCreate(savedInstanceState);

        // A WebView refuses camera access silently unless the host app passes the request on.
        // Without this the in-app camera falls back to the photo picker with no explanation.
        Bridge bridge = getBridge();
        WebView webView = bridge.getWebView();
        webView.setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }
        });

        // The phone's Back goes back one screen inside the app, like a browser, instead of closing
        // it. On the first screen it sends the app to the background (a running lecture keeps going).
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                Bridge b = getBridge();
                WebView wv = b != null ? b.getWebView() : null;
                if (wv != null && wv.canGoBack()) wv.goBack();
                else moveTaskToBack(true);
            }
        });
    }

    private void handleWebPermission(PermissionRequest request) {
        boolean wantsCamera = false, wantsMic = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
        }
        if (!wantsCamera && !wantsMic) {
            request.deny();
            return;
        }
        // The camera for photographing slides; the microphone for the voice quiz and the case
        // simulator. Each is passed on to the page only once Android itself has granted it.
        java.util.List<String> need = new java.util.ArrayList<>();
        if (wantsCamera && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.CAMERA);
        if (wantsMic && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO);
        if (need.isEmpty()) {
            grantAllowed(request);
            return;
        }
        pendingWebRequest = request;
        ActivityCompat.requestPermissions(this, need.toArray(new String[0]), CAMERA_REQUEST);
    }

    private void grantAllowed(PermissionRequest request) {
        java.util.List<String> ok = new java.util.ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) ok.add(r);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) ok.add(r);
        }
        if (ok.isEmpty()) request.deny(); else request.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_REQUEST && pendingWebRequest != null) {
            PermissionRequest req = pendingWebRequest;
            pendingWebRequest = null;
            grantAllowed(req);
        }
    }
}
