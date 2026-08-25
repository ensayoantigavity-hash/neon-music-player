package com.neonmusic.listener;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    // Reproductor de escucha (solo audio) de Neon Music.
    private static final String RADIO_URL = "https://neon-music-player.onrender.com/escuchar";
    private WebView webview;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // Servicio en primer plano: mantiene el audio vivo aunque se apague la
        // pantalla o el movil entre en hibernacion (wake lock + notificacion).
        Intent svc = new Intent(this, PlaybackService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
        else startService(svc);

        webview = findViewById(R.id.webview);
        webview.addJavascriptInterface(new Bridge(), "AndroidBridge");
        WebSettings ws = webview.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        // Permite el autoarranque del audio sin gesto (la politica del navegador lo limita,
        // pero lo intentamos; el primer toque en la pantalla lo libera igual que en la web).
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        webview.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(android.webkit.WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
            }
        });
        webview.setWebChromeClient(new WebChromeClient());
        webview.loadUrl(RADIO_URL);
    }

    @Override
    protected void onDestroy() {
        stopService(new Intent(this, PlaybackService.class));
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webview != null && webview.canGoBack()) webview.goBack();
        else super.onBackPressed();
    }

    // Puente con la pagina (listener.js) para enviar la cancion al Now Bar
    private class Bridge {
        @JavascriptInterface
        public void updateTrack(String title, String artist) {
            Intent i = new Intent("com.neonmusic.listener.TRACK");
            i.putExtra("title", title);
            i.putExtra("artist", artist);
            sendBroadcast(i);
        }
    }
}
