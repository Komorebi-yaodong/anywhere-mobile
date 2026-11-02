package com.anywheremobile;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** view_image policy: original dimensions; one PNG and opaque JPEG80, smaller only. */
final class GatewayImageOptimizer {
  static GatewayUploads.Optimized optimize(File file,String name,String type) throws Exception {
    // Never flatten animated inputs or attempt unsupported codecs implicitly.
    if(!type.equals("image/jpeg")&&!type.equals("image/png"))return new GatewayUploads.Optimized(name,type);
    if(file.length()>20L*1024*1024)return new GatewayUploads.Optimized(name,type);
    if(type.equals("image/png") && animatedPng(file))return new GatewayUploads.Optimized(name,type);

    BitmapFactory.Options bounds=new BitmapFactory.Options();bounds.inJustDecodeBounds=true;BitmapFactory.decodeFile(file.getPath(),bounds);
    if(bounds.outWidth<1||bounds.outHeight<1||(long)bounds.outWidth*bounds.outHeight>24L*1024*1024)throw new IllegalArgumentException("remote_upload_dimensions_invalid");
    Bitmap bitmap=null;File png=null,jpeg=null;
    try {
      BitmapFactory.Options options=new BitmapFactory.Options();options.inPreferredConfig=Bitmap.Config.ARGB_8888;
      bitmap=BitmapFactory.decodeFile(file.getPath(),options);if(bitmap==null)throw new IllegalArgumentException("remote_upload_image_invalid");
      int orientation=new ExifInterface(file.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL);
      Matrix matrix=new Matrix();
      switch(orientation){case 2:matrix.setScale(-1,1);break;case 3:matrix.setRotate(180);break;case 4:matrix.setScale(1,-1);break;case 5:matrix.setRotate(90);matrix.postScale(-1,1);break;case 6:matrix.setRotate(90);break;case 7:matrix.setRotate(-90);matrix.postScale(-1,1);break;case 8:matrix.setRotate(-90);break;default:break;}
      if(!matrix.isIdentity()){Bitmap rotated=Bitmap.createBitmap(bitmap,0,0,bitmap.getWidth(),bitmap.getHeight(),matrix,true);if(rotated!=bitmap){bitmap.recycle();bitmap=rotated;}}
      boolean transparent=false;int width=bitmap.getWidth();int[] strip=new int[width*Math.min(64,bitmap.getHeight())];
      for(int y=0;y<bitmap.getHeight()&&!transparent;y+=64){int height=Math.min(64,bitmap.getHeight()-y);bitmap.getPixels(strip,0,width,0,y,width,height);for(int i=0;i<width*height;i++)if((strip[i]>>>24)!=255){transparent=true;break;}}
      java.util.Arrays.fill(strip,0);
      png=File.createTempFile("optimized-",".png",file.getParentFile());encode(bitmap,Bitmap.CompressFormat.PNG,100,png);
      File best=png;String outputType="image/png",extension=".png";
      if(!transparent){jpeg=File.createTempFile("optimized-",".jpg",file.getParentFile());encode(bitmap,Bitmap.CompressFormat.JPEG,80,jpeg);if(jpeg.length()<best.length()){best=jpeg;outputType="image/jpeg";extension=".jpg";}}
      if(best.length()>0&&best.length()<file.length()){
        Files.move(best.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING);
        String stem=name.replaceFirst("\\.[^.]*$","");if(stem.isEmpty())stem="image";
        // Native output MIME and extension always agree, independent of input URI.
        return new GatewayUploads.Optimized(stem+extension,outputType);
      }
      return new GatewayUploads.Optimized(name,type);
    }catch(OutOfMemoryError error){throw new IllegalStateException("remote_upload_capacity");}
    finally{if(bitmap!=null)bitmap.recycle();if(png!=null)png.delete();if(jpeg!=null)jpeg.delete();}
  }
  private static boolean animatedPng(File file)throws IOException {
    try(DataInputStream input=new DataInputStream(new FileInputStream(file))){
      if(input.readLong()!=0x89504e470d0a1a0aL)return false;
      long remaining=file.length()-8;
      while(remaining>=12){long length=Integer.toUnsignedLong(input.readInt());int type=input.readInt();remaining-=12;if(length>remaining)return false;if(type==0x6163544c)return true;if(type==0x49444154||type==0x49454e44)return false;long skip=length+4;while(skip>0){long n=input.skip(skip);if(n<=0)throw new EOFException();skip-=n;}remaining-=length;}
      return false;
    }
  }

  private static void encode(Bitmap bitmap,Bitmap.CompressFormat format,int quality,File file)throws IOException {
    try(OutputStream out=new BufferedOutputStream(new FileOutputStream(file))){if(!bitmap.compress(format,quality,out))throw new IOException("remote_upload_image_invalid");}
  }
}
