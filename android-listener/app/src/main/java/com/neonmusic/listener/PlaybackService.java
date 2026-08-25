package com.neonmusic.listener;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class PlaybackService extends Service {
    private static final int NOTIF_ID = 1;
    private static final String CHANNEL_ID = "neon_playback";
    public static final String ACTION_TRACK = "com.neonmusic.listener.TRACK";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";

    private PowerManager.WakeLock wakeLock;
    private MediaSession mediaSession;
    private AudioManager audioManager;
    private BroadcastReceiver trackReceiver;
    private String currentTitle = "Neon Music Radio";
    private String currentArtist = "Reproduciendo...";

    @Override
    public void onCreate() {
        super.onCreate();

        // Toma el foco de audio para que el sistema no suspenda la reproduccion
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.requestAudioFocus(new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build())
                    .build());
        } else {
            audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }

        // Wake lock parcial: CPU activa aunque se apague la pantalla
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NeonMusic::PlaybackWakeLock");
        wakeLock.acquire();

        // MediaSession activa -> el sistema muestra el Now Bar y no silencia el audio
        mediaSession = new MediaSession(this, "NeonMusicSession");
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mediaSession.setCallback(new MediaSession.Callback() {});
        PlaybackState state = new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE)
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .build();
        mediaSession.setPlaybackState(state);
        mediaSession.setActive(true);

        // Recibe el titulo/artista desde el WebView (listener.js -> AndroidBridge)
        trackReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_TRACK.equals(intent.getAction())) {
                    currentTitle = intent.getStringExtra(EXTRA_TITLE);
                    currentArtist = intent.getStringExtra(EXTRA_ARTIST);
                    if (currentTitle == null) currentTitle = "Neon Music Radio";
                    if (currentArtist == null) currentArtist = "";
                    updateNotification();
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_TRACK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            registerReceiver(trackReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(trackReceiver, filter);

        startForeground(NOTIF_ID, buildNotification());
    }

    private Notification buildNotification() {
        Intent intent = new Intent(this, MainActivity.class);
        int pflag = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent pi = PendingIntent.getActivity(this, 0, intent, pflag);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Neon Music Radio", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Reproductor de Neon Music");
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE))
                    .createNotificationChannel(ch);
        }

        Notification.MediaStyle style = new Notification.MediaStyle();
        style.setMediaSession(mediaSession.getSessionToken());

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            builder = new Notification.Builder(this, CHANNEL_ID);
        else builder = new Notification.Builder(this);

        builder.setContentTitle(currentTitle)
                .setContentText(currentArtist)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pi)
                .setOngoing(true)
                .setStyle(style)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        return builder.build();
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(NOTIF_ID, buildNotification());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (trackReceiver != null) try { unregisterReceiver(trackReceiver); } catch (Exception e) {}
        if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); }
        if (audioManager != null) audioManager.abandonAudioFocus(null);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(true);
        super.onDestroy();
    }
}
