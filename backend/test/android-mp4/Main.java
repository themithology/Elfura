package online.theogpiratebot.mediatest;
import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.media.MediaMetadataRetriever;
import android.media.MediaPlayer;
import android.util.Log;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import java.io.File;
import java.util.concurrent.atomic.AtomicBoolean;

public class Main extends Activity {
  private final Handler handler=new Handler();
  private SurfaceHolder holder;
  private String[] files={"fragmented.mp4", "patched-movie.mp4", "patched-all.mp4", "standard.mp4"};
  private int idx=0;
  @Override public void onCreate(Bundle b){super.onCreate(b);SurfaceView view=new SurfaceView(this);setContentView(view);view.getHolder().addCallback(new SurfaceHolder.Callback(){public void surfaceCreated(SurfaceHolder h){holder=h;runNext();}public void surfaceChanged(SurfaceHolder h,int f,int w,int he){}public void surfaceDestroyed(SurfaceHolder h){}});}
  private void runNext(){
    if(idx>=files.length){Log.i("ElfuraTest","DONE");return;}
    final String name=files[idx++];final File f=new File(getExternalFilesDir(null),name);
    try{
      MediaMetadataRetriever m=new MediaMetadataRetriever();m.setDataSource(f.toString());String duration=m.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);m.release();
      final AtomicBoolean done=new AtomicBoolean(false);final MediaPlayer player=new MediaPlayer();player.setDisplay(holder);player.setDataSource(f.toString());
      player.setOnErrorListener((p,what,extra)->{Log.i("ElfuraTest","RESULT "+name+" ERROR "+what+" "+extra);if(done.compareAndSet(false,true)){player.release();runNext();}return true;});
      player.setOnPreparedListener(p->{int d=p.getDuration();p.start();handler.postDelayed(()->{if(done.get())return;try{int position=p.getCurrentPosition();boolean playing=p.isPlaying();p.seekTo(6000);handler.postDelayed(()->{if(done.get())return;try{int seekPosition=p.getCurrentPosition();Log.i("ElfuraTest","RESULT "+name+" metadata="+duration+" duration="+d+" position="+position+" playing="+playing+" seek="+seekPosition+" size="+p.getVideoWidth()+"x"+p.getVideoHeight());}catch(Exception ex){Log.i("ElfuraTest","RESULT "+name+" seek exception="+ex.getClass().getSimpleName());}if(done.compareAndSet(false,true)){p.release();runNext();}},1200);}catch(Exception ex){Log.i("ElfuraTest","RESULT "+name+" exception="+ex.getClass().getSimpleName());if(done.compareAndSet(false,true)){p.release();runNext();}}},3000);});
      player.prepareAsync();
    }catch(Exception e){Log.i("ElfuraTest","RESULT "+name+" EXCEPTION "+e.getClass().getSimpleName());runNext();}
  }
}
