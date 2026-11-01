# Windows audio routing utility

## Companion runtime

The installer includes Electron and its original runtime licenses. Its bundled WebSocket client is `ws` (MIT); the license is installed under `resources/licenses/`. FFmpeg is an unmodified separate executable from `ffmpeg-static` release `b6.1.1`, Gyan 6.1.1 essentials build, GPL v3. The executable's original full license and build/source README are installed beside it under `resources/audio/`. FFmpeg source revision: https://github.com/FFmpeg/FFmpeg/commit/e38092ef93 . The original README identifies its external-library versions and build configuration. Upstream distribution and build materials: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1 and https://www.gyan.dev/ffmpeg/builds/ . VB-CABLE is a separate prerequisite obtained by each user from its author; its driver is not included in this installer.

The local control panel uses **SoundVolumeCommandLine (svcl), x64, v1.28**, by Nir Sofer.

- Official documentation: https://www.nirsoft.net/utils/sound_volume_command_line.html
- Download: https://www.nirsoft.net/utils/svcl-x64.zip
- Executable SHA-256 on download: `0C4738296D253495BC995DA7B5938E27B306C8F204DC9F7D4D5D455F1D8D3E38`
- Original distribution files are kept unchanged in `tools/svcl/`, including the author's readme and help file.

This is freeware, not an open-source dependency. Its license permits free redistribution with all original files unmodified, and prohibits charging for it or distributing it as part of a commercial product. Read the bundled author's license before redistribution. No utility installer, system service, or driver is installed by the panel. It invokes the portable utility to list devices and set the selected application's output device.
