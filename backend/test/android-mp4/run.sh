#!/usr/bin/env bash
set -euo pipefail
D="$RUNNER_TEMP/elfura-android"; mkdir -p "$D/classes" "$D/dex"
ANDROID_JAR="$ANDROID_HOME/platforms/android-35/android.jar"
TOOLS="$ANDROID_HOME/build-tools/35.0.0"
javac -source 8 -target 8 -classpath "$ANDROID_JAR" -d "$D/classes" backend/test/android-mp4/Main.java
"$TOOLS/d8" --min-api 23 --lib "$ANDROID_JAR" --output "$D/dex" $(find "$D/classes" -name '*.class')
"$TOOLS/aapt" package -f -M backend/test/android-mp4/AndroidManifest.xml -I "$ANDROID_JAR" -F "$D/test.apk"
(cd "$D/dex" && zip -q "$D/test.apk" classes.dex)
keytool -genkeypair -keystore "$D/test.keystore" -storepass android -keypass android -alias test -dname CN=Test -keyalg RSA -validity 365 >/dev/null 2>&1
"$TOOLS/zipalign" -f 4 "$D/test.apk" "$D/aligned.apk"
"$TOOLS/apksigner" sign --ks "$D/test.keystore" --ks-pass pass:android --key-pass pass:android --out "$D/signed.apk" "$D/aligned.apk"
adb install -r "$D/signed.apk"
adb shell mkdir -p /sdcard/Android/data/online.theogpiratebot.mediatest/files
adb push "$RUNNER_TEMP/fragmented.mp4" /sdcard/Android/data/online.theogpiratebot.mediatest/files/fragmented.mp4 >/dev/null
adb push "$RUNNER_TEMP/patched-movie.mp4" /sdcard/Android/data/online.theogpiratebot.mediatest/files/patched-movie.mp4 >/dev/null
adb push "$RUNNER_TEMP/patched-all.mp4" /sdcard/Android/data/online.theogpiratebot.mediatest/files/patched-all.mp4 >/dev/null
adb push "$RUNNER_TEMP/dash-patched.mp4" /sdcard/Android/data/online.theogpiratebot.mediatest/files/dash-patched.mp4 >/dev/null
adb push "$RUNNER_TEMP/standard.mp4" /sdcard/Android/data/online.theogpiratebot.mediatest/files/standard.mp4 >/dev/null
adb push "$RUNNER_TEMP/combined.ts" /sdcard/Android/data/online.theogpiratebot.mediatest/files/combined.ts >/dev/null
adb logcat -c
adb shell am start -n online.theogpiratebot.mediatest/.Main >/dev/null
for i in $(seq 1 45); do
  if adb logcat -d -s ElfuraTest:I '*:S' | grep -q DONE; then break; fi
  sleep 1
done
LOG=$(adb logcat -d -s ElfuraTest:I '*:S')
echo "$LOG"
while IFS= read -r line; do echo "::notice title=AndroidMP4::$line"; done < <(echo "$LOG" | grep 'RESULT' || true)
echo "$LOG" | grep -q DONE
