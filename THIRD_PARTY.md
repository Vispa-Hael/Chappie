# Windows audio routing utility

VB-CABLE is a separate prerequisite obtained from its author; its driver is not included in this project.

The local control panel uses **SoundVolumeCommandLine (svcl), x64, v1.28**, by Nir Sofer.

- Official documentation: https://www.nirsoft.net/utils/sound_volume_command_line.html
- Download: https://www.nirsoft.net/utils/svcl-x64.zip
- Executable SHA-256 on download: `0C4738296D253495BC995DA7B5938E27B306C8F204DC9F7D4D5D455F1D8D3E38`
- Original distribution files are kept unchanged in `tools/svcl/`, including the author's readme and help file.

This is freeware, not an open-source dependency. Its license permits free redistribution with all original files unmodified, and prohibits charging for it or distributing it as part of a commercial product. Read the bundled author's license before redistribution. No utility installer, system service, or driver is installed by the panel. It invokes the portable utility to list devices and set the selected application's output device.
