# Installation and maintenance map

Date: 2026-09-06

The user requested a current STATE map from which a cold Agent can install, maintain and remove the retained capability without the old conversation. This documentation update preserves confirmed behavior, keeps implementation choices target-dependent and leaves protocol selection and realization acceptance unchanged.

The default room directory resolves from the OS home directory, not DSH_HOME. Installation and removal must preserve it, and a disposable explicit roomsDir isolates verification. The map keeps generic room ownership separate from optional game composition.

These findings come from the manifest, Bundle/build scripts and owning sources. Historical installation statements are evidence for their recorded target, not a fresh deployment check. No build, live install, restart or provider/browser acceptance was performed for this prose change.
