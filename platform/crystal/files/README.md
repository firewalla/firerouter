# miniupnpd build record
commit hash: https://github.com/firewalla/miniupnp  (3cd97c24ba6f9277f25fc5cecb80968743473cde)
Build environment: crystal Ubuntu 26.04

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends pkg-config libnftnl-dev libmnl-dev libssl-dev uuid-dev libjitterentropy3-dev libzstd-dev upx-ucl
cd miniupnp/miniupnpd && ./configure --firewall=nftables --leasefile --vendorcfg && make -j4
upx --brute miniupnpd
```
