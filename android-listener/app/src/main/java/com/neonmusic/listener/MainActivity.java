package com.neonmusic.listener;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
    // Acciones internas entre el WebView (listener.js) y el servicio nativo.
    public static final String ACTION_ENDED = "com.neonmusic.listener.ENDED";
    public static final String ACTION_ERROR = "com.neonmusic.listener.ERROR";
    private WebView webview;
    private BroadcastReceiver nativeReceiver;

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

        // El reproductor nativo (PlaybackService) avisa cuando un tema termina o
        // falla; el listener.js entonces avanza al siguiente sin tocar YouTube.
        nativeReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (webview == null) return;
                if (ACTION_ENDED.equals(intent.getAction()))
                    webview.evaluateJavascript("window.__neonTrackEnded && window.__neonTrackEnded();", null);
                else if (ACTION_ERROR.equals(intent.getAction()))
                    webview.evaluateJavascript("window.__neonTrackError && window.__neonTrackError();", null);
            }
        };
        IntentFilter nf = new IntentFilter(ACTION_ENDED);
        nf.addAction(ACTION_ERROR);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            registerReceiver(nativeReceiver, nf, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(nativeReceiver, nf);
    }

    @Override
    protected void onDestroy() {
        if (nativeReceiver != null) try { unregisterReceiver(nativeReceiver); } catch (Exception e) {}
        stopService(new Intent(this, PlaybackService.class));
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webview != null && webview.canGoBack()) webview.goBack();
        else super.onBackPressed();
    }

    // Puente con la pagina (listener.js): recibe el stream del servidor y las
    // ordenes de play/pausa/volumen para reproducir de forma nativa (sin YouTube).
    private class Bridge {
        @JavascriptInterface
        public void updateTrack(String title, String artist, String url) {
            Intent i = new Intent(PlaybackService.ACTION_TRACK);
            i.putExtra(PlaybackService.EXTRA_TITLE, title);
            i.putExtra(PlaybackService.EXTRA_ARTIST, artist);
            i.putExtra(PlaybackService.EXTRA_URL, url);
            sendBroadcast(i);
        }

        @JavascriptInterface
        public void setPlaying(boolean playing) {
            Intent i = new Intent(PlaybackService.ACTION_SET_PLAYING);
            i.putExtra(PlaybackService.EXTRA_PLAYING, playing);
            sendBroadcast(i);
        }

        @JavascriptInterface
        public void setVolume(int percent) {
            Intent i = new Intent(PlaybackService.ACTION_SET_VOLUME);
            i.putExtra(PlaybackService.EXTRA_VOLUME, percent);
            sendBroadcast(i);
        }
    }
}
