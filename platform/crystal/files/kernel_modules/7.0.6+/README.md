# amneziawg.ko (Crystal, kernel 7.0.6+)

Out-of-tree AmneziaWG kernel module for the Crystal platform.

## Build environment

**Kernel source**: Crystal kernel tree (`linux-ubuntu-resolute-7.0.0-27`, Makefile version 7.0.6).

## Source

- Repo: https://github.com/amnezia-vpn/amneziawg-linux-kernel-module (official)
- Tag: `v1.0.20260611` (commit `2a6e1a02ac024f54a23e18f894a279b7f870b8fb`, master)

We build from the **official** repo.

## How it was built

```bash
git clone https://github.com/amnezia-vpn/amneziawg-linux-kernel-module
cd amneziawg-linux-kernel-module && git checkout v1.0.20260611
cd src
make KERNELDIR=/path/to/crystal-kernel KCFLAGS="-g0" CONFIG_DEBUG_INFO_BTF_MODULES=
# optional
strip --strip-debug amneziawg.ko
xz -9 amneziawg.ko && mv amneziawg.ko.xz amneziawg.ko
```
