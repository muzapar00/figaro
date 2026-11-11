# ---------------------------------------------------------------------------
# Figaro RPM spec — Fedora and openSUSE Tumbleweed (one spec, both families).
#
#   packaging/rpm/build-rpm.sh          # local helper (needs rpmbuild)
#   rpmbuild -ba packaging/rpm/figaro.spec
#
# Layout mirrors the deb/AUR packages:
#   %{_libdir}/figaro/{bin,src,node_modules,scripts,qml,settings,systemd,assets,config,package.json}
#   /usr/bin/{figaro,figaro-ui,figaro-settings}
#   /usr/lib/systemd/user/{figaro,figaro-ui}.service
#   %{_datadir}/{applications,icons}
#   %{_docdir}/figaro, %{_licensedir}/figaro
#
# Models are not bundled (scripts/fetch-models.sh downloads them at run time);
# no config.json and no API key is ever packaged. The user-level half (QML in
# ~/.config/quickshell, user units) is installed by "figaro install-user".
# ---------------------------------------------------------------------------
%global debug_package %{nil}
%{!?_licensedir:%global _licensedir %{_datadir}/licenses}

Name:           figaro
Version:        1.0.0
Release:        1%{?dist}
Summary:        System-level voice assistant for the Linux desktop
License:        GPL-3.0-or-later
URL:            https://github.com/muzapar00/figaro
Source0:        %{url}/archive/v%{version}/%{name}-%{version}.tar.gz
ExclusiveArch:  x86_64

# Runtime: Node >= 22 runs the daemon; PipeWire carries the microphone and
# speaker; the portal provides the global-shortcut and screenshot interfaces;
# Quickshell draws the overlay (Wayland only).
Requires:       nodejs >= 22
Requires:       pipewire
Requires:       xdg-desktop-portal
Requires:       quickshell

# Build: production Node deps come from package-lock.json (network in build, as
# with any Node RPM; the sherpa native runtime is a prebuilt platform package).
BuildRequires:  nodejs >= 22
BuildRequires:  npm
BuildRequires:  gzip

%if 0%{?fedora}
Recommends:     xdg-desktop-portal-kde
Recommends:     spectacle
Recommends:     ffmpeg-free
Recommends:     grim
Recommends:     curl
Recommends:     bzip2
%endif
%if 0%{?suse_version}
Recommends:     xdg-desktop-portal-kde
Recommends:     spectacle
Recommends:     ffmpeg
Recommends:     curl
Recommends:     bzip2
%endif

%description
Figaro is a background voice assistant for Wayland desktops: a local bilingual
wake word (Chinese + English), local speech recognition, a DeepSeek agent with
local tools (files, bash, screen, web) and MiniMax streaming speech output.

This package installs the program tree, launchers, machine-independent systemd
user units, the desktop entry and the icons. The user services and the per-user
Quickshell/QML installation are created by running "figaro install-user" as
your normal user (the %%post scriptlet prints how). The speech models are not
bundled; /usr/lib/figaro/scripts/fetch-models.sh downloads them at run time.

%prep
%setup -q

%build
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --allow-remote=all

%install
rm -rf %{buildroot}
install -d %{buildroot}%{_libdir}/figaro
for tree in bin src scripts qml settings systemd assets config; do
  cp -a "$tree" %{buildroot}%{_libdir}/figaro/
done
cp -a package.json package-lock.json %{buildroot}%{_libdir}/figaro/
cp -a node_modules %{buildroot}%{_libdir}/figaro/node_modules

# Runtime-only payload: dev helpers and self-test evidence stay out of the RPM.
rm -rf %{buildroot}%{_libdir}/figaro/qml/test
rm -f  %{buildroot}%{_libdir}/figaro/qml/ctl.sh %{buildroot}%{_libdir}/figaro/qml/deploy.sh
rm -rf %{buildroot}%{_libdir}/figaro/settings/test
rm -f  %{buildroot}%{_libdir}/figaro/settings/*.sh
rm -f  %{buildroot}%{_libdir}/figaro/config/config.json

chmod 755 %{buildroot}%{_libdir}/figaro/bin/figaro
find %{buildroot}%{_libdir}/figaro/scripts -name '*.sh' -exec chmod 755 {} +

# Launchers: rendered from the shared templates, so the package never carries a
# build-host path and the Node/qs lookup happens at run time.
install -d %{buildroot}%{_bindir}
for launcher in figaro figaro-ui figaro-settings; do
  sed -e "s|@LIBDIR@|%{_libdir}/figaro|g" \
      -e "s|@DOCDIR@|%{_docdir}/figaro|g" \
      packaging/common/launcher-${launcher}.sh > %{buildroot}%{_bindir}/${launcher}
  chmod 755 %{buildroot}%{_bindir}/${launcher}
done

# systemd user units (machine-independent; /usr/lib/systemd/user on every arch).
install -d %{buildroot}%{_prefix}/lib/systemd/user
for unit in figaro figaro-ui; do
  sed -e "s|@DOCDIR@|%{_docdir}/figaro|g" \
      packaging/common/systemd-user/${unit}.service > %{buildroot}%{_prefix}/lib/systemd/user/${unit}.service
  chmod 644 %{buildroot}%{_prefix}/lib/systemd/user/${unit}.service
done

install -Dm644 packaging/common/desktop/figaro-settings.desktop \
  %{buildroot}%{_datadir}/applications/figaro-settings.desktop
for size in 512 256 128 64 48 32; do
  [ -f assets/icons/figaro-${size}.png ] || continue
  install -Dm644 assets/icons/figaro-${size}.png \
    %{buildroot}%{_datadir}/icons/hicolor/${size}x${size}/apps/figaro.png
done

install -d %{buildroot}%{_docdir}/figaro
install -m644 README.md README.zh-CN.md CHANGELOG.md THIRD_PARTY_NOTICES.md %{buildroot}%{_docdir}/figaro/
for doc in platform-support.md ipc.md motion.md privacy.md rag.md voice-interaction.md smarthome-integration.md; do
  [ -f docs/${doc} ] && install -m644 docs/${doc} %{buildroot}%{_docdir}/figaro/${doc}
done
install -m644 packaging/deb/README.Debian %{buildroot}%{_docdir}/figaro/README.package
install -Dm644 LICENSE %{buildroot}%{_licensedir}/figaro/LICENSE

%files
%license %{_licensedir}/figaro/LICENSE
%dir %{_docdir}/figaro
%{_docdir}/figaro/*
%{_bindir}/figaro
%{_bindir}/figaro-ui
%{_bindir}/figaro-settings
%dir %{_libdir}/figaro
%{_libdir}/figaro/*
%{_prefix}/lib/systemd/user/figaro.service
%{_prefix}/lib/systemd/user/figaro-ui.service
%{_datadir}/applications/figaro-settings.desktop
%{_datadir}/icons/hicolor/*/apps/figaro.png

%post
cat >&2 <<'FIGARO_POST'
==================================================================
 费加罗已安装到 %{_libdir}/figaro。还差最后一步（不要用 sudo）：
     figaro install-user
 它会以你的用户身份创建 QML 目录、config 脚手架和 systemd user units。
 也可以直接点应用菜单里的「费加罗」，首次启动会自动完成。
 之后：figaro doctor
==================================================================
FIGARO_POST

%preun
if [ "$1" -eq 0 ]; then
cat >&2 <<'FIGARO_PREUN'
移除 Figaro 前，请以桌面用户执行：
     systemctl --user disable --now figaro figaro-ui
用户数据保留：~/.config/figaro（key/声纹）、~/.local/share/figaro/models
FIGARO_PREUN
fi

%changelog
* Wed Nov 11 2026 muzapar00 <mzpr00@163.com> - 1.0.0-1
- Figaro 1.0.0: first packaged release (deb/AUR/rpm), Wayland platform support
  matrix, non-KDE screenshot/glass fallbacks, user-level install command.
