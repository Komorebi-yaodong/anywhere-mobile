package com.anywheremobile;

import android.graphics.*;
import android.media.ExifInterface;
import java.io.*;
import java.nio.file.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=28, manifest=Config.NONE, application=android.app.Application.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class GatewayImageOptimizerTest {
  File root;
  @Before public void setup()throws Exception{root=Files.createTempDirectory("synthetic-image-codec-").toFile();}
  @After public void cleanup(){for(File f:root.listFiles())f.delete();root.delete();}
  private File image(boolean transparent)throws Exception{
    Bitmap b=Bitmap.createBitmap(320,180,Bitmap.Config.ARGB_8888);
    for(int y=0;y<180;y++)for(int x=0;x<320;x++)b.setPixel(x,y,Color.argb(transparent&&x<100?60:255,(x*7)%256,(y*5)%256,(x+y)%256));
    File f=new File(root,"selected.png");try(OutputStream out=new FileOutputStream(f)){assertTrue(b.compress(Bitmap.CompressFormat.PNG,100,out));}b.recycle();return f;
  }
  @Test public void choosesSmallerAndPreservesDimensionsAndSource()throws Exception{
    File source=image(false),copy=new File(root,"copy.part");Files.copy(source.toPath(),copy.toPath());byte[] original=Files.readAllBytes(source.toPath());
    // Add harmless trailing fixture bytes so the single-pass savings are deterministic.
    try(OutputStream out=new FileOutputStream(copy,true)){out.write(new byte[150000]);}
    long before=copy.length();GatewayUploads.Optimized result=GatewayImageOptimizer.optimize(copy,"photo.png","image/png");
    assertTrue(copy.length()<before);assertArrayEquals(original,Files.readAllBytes(source.toPath()));
    Bitmap decoded=BitmapFactory.decodeFile(copy.getPath());assertNotNull(decoded);assertEquals(320,decoded.getWidth());assertEquals(180,decoded.getHeight());decoded.recycle();
    assertTrue(result.type.equals("image/jpeg")||result.type.equals("image/png"));assertTrue(result.name.endsWith(result.type.equals("image/jpeg")?".jpg":".png"));
  }
  @Test public void transparencyRemainsPng()throws Exception{
    File f=image(true);GatewayUploads.Optimized r=GatewayImageOptimizer.optimize(f,"transparent.png","image/png");assertEquals("image/png",r.type);
    Bitmap b=BitmapFactory.decodeFile(f.getPath());assertTrue(Color.alpha(b.getPixel(10,10))<255);b.recycle();
  }
  @Test public void originalIsKeptWhenSmallerAndAnimationIsNotFlattened()throws Exception{
    File f=image(true);byte[] original=Files.readAllBytes(f.toPath());GatewayImageOptimizer.optimize(f,"small.png","image/png");assertTrue(f.length()<=original.length);
    File animated=new File(root,"animated.gif");byte[] bytes="synthetic-animation".getBytes("UTF-8");Files.write(animated.toPath(),bytes);GatewayImageOptimizer.optimize(animated,"animated.gif","image/gif");assertArrayEquals(bytes,Files.readAllBytes(animated.toPath()));
    Bitmap tiny=Bitmap.createBitmap(1,1,Bitmap.Config.ARGB_8888);File small=new File(root,"tiny.jpg");try(OutputStream out=new FileOutputStream(small)){tiny.compress(Bitmap.CompressFormat.JPEG,10,out);}tiny.recycle();byte[] before=Files.readAllBytes(small.toPath());GatewayImageOptimizer.optimize(small,"tiny.jpg","image/jpeg");assertTrue(small.length()<=before.length);
  }
  @Test public void normalizesExifOrientationWithoutResizing()throws Exception{
    File f=image(false);Bitmap b=BitmapFactory.decodeFile(f.getPath());File jpeg=new File(root,"rotated.jpg");try(OutputStream out=new FileOutputStream(jpeg)){b.compress(Bitmap.CompressFormat.JPEG,100,out);}b.recycle();
    ExifInterface exif=new ExifInterface(jpeg.getPath());exif.setAttribute(ExifInterface.TAG_ORIENTATION,"6");exif.saveAttributes();try(OutputStream out=new FileOutputStream(jpeg,true)){out.write(new byte[100000]);}
    GatewayImageOptimizer.optimize(jpeg,"rotated.jpg","image/jpeg");Bitmap output=BitmapFactory.decodeFile(jpeg.getPath());assertEquals(180,output.getWidth());assertEquals(320,output.getHeight());output.recycle();
  }
}
