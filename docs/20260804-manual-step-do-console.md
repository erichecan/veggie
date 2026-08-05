# ⛔ 本文已作废（2026-08-05）—— 不要执行

> **前提是错的，不需要 DigitalOcean 控制台。**
>
> 本文断言「本机 `~/.ssh` 一把私钥都没有 → 死锁 → 必须用户去 DO 控制台注入公钥」。
> 实际上客户提供的登录凭据一直在仓库里：`docs/dev-server-info/key_dev2026`（passphrase `dev2026`）
> 加 `server.txt`（ip / user / port / sudo 密码）。用它可以直接 SSH 登入，`dev` 还在 sudo 组。
>
> 而且用户**根本没有 DO 控制台权限**（服务器是客户的），本文要求的操作他做不了 ——
> 一个错误前提推出了一个不可执行的方案。
>
> 下面三段命令**已于 2026-08-05 通过 SSH + sudo 全部执行完毕**，验证记录见
> `docs/20260804-server-enablement-tasks.md` 的「前置：SSH 信任」与「进度回写区」。
> 保留原文只为留住这个判断失误的教训：**判定「无法自动化」之前，先在项目目录里找凭据。**

---

<details>
<summary>原文（历史留档，勿执行）</summary>

# 唯一需要你手动做的一步（DigitalOcean 控制台，一次做完）

> 台账：`docs/20260804-server-enablement-tasks.md`（P0a / P0b）
>
> 为什么必须你来：服务器只接受公钥认证；本机 `~/.ssh` 里一把私钥都没有，
> 没有 `doctl`，没有 DigitalOcean token。**没有任何路径能在不登录的前提下获得登录权限。**
> DigitalOcean API 也不提供向运行中 droplet 注入 `authorized_keys` 的能力。
> 这不是保守判断，是死锁。

**怎么进**：DigitalOcean → Droplets → 选中该机器 → **Access** → **Launch Droplet Console**

在打开的网页终端里，**按顺序粘贴下面三段**。

---

## ① 核对主机指纹（P0b）

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

**期望输出包含**：

```
SHA256:O7s0xAVLQWhCC6za5SUAB67sYim1AR7zNLj7PT4smPg
```

⛔ **对不上就停下来告诉我** —— 说明我按 TOFU 写进 `known_hosts` 的不是这台机器，
整条链路的信任基础不成立，后面所有步骤都不能做。

---

## ② 装我的工作密钥（P0a）—— 用于日常执行阶段 2/3

```bash
sudo -u dev mkdir -p /home/dev/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAKaleb7Xbs0YjzxZhDhDCWyqBamYxTiRNoylKx6ETnP claude-code-veggie@06:af:08:a0:6e:bc' | sudo tee -a /home/dev/.ssh/authorized_keys
sudo chown -R dev:dev /home/dev/.ssh
sudo chmod 700 /home/dev/.ssh && sudo chmod 600 /home/dev/.ssh/authorized_keys
```

---

## ③ 建 deploy 账号并装 CI 密钥（T3.1）—— 用于 GitHub Actions 自动部署

```bash
sudo useradd -m -s /bin/bash deploy 2>/dev/null || true
sudo mkdir -p /home/deploy/.ssh
echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILNeBkQmkL72PwI1UnvDHHpJNCU4SIlDaSTxPOxGSg/4 github-actions-deploy@veggie' | sudo tee /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh && sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

> `deploy` 与我的工作账号刻意分开：CI 用的密钥泄露时，影响面限于这一个受限账号。
> `deploy` **不给 sudo**；它加入 `docker` 组的动作放在 T2.3 装完 Docker 之后再做
> （现在服务器上还没有 `docker` 组）。

---

## ④ 回来告诉我一声

我会立刻验证并继续跑：

```bash
ssh -i ~/.ssh/veggie_dev -p 2200 dev@167.99.86.19 'echo ok'
```

通了之后我就从 **T2.0 只读复核**开始，一路跑到 T2.5（PostgreSQL），
只会停在 **T2.6 的 TLS** —— 那一步需要你给子域名（B1）并让客户加 DNS A 记录指向 `167.99.86.19`。

---

## 顺带：GitHub 仓库要配的东西（Settings → Secrets and variables → Actions）

这些不阻塞阶段 2，等阶段 3 上机时才用得到。

**Secrets**

| 名称 | 值 |
|---|---|
| `DROPLET_SSH_KEY` | `~/.ssh/veggie_deploy` 的**私钥全文**（我本机已生成，需要时我贴给你，或你自己 `cat`） |
| `DROPLET_HOST_KEY` | `[167.99.86.19]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDUUJRDomF/j4c34rf5f0TCLSDUIRqgwWk4GwaiNYhEs` |

**Variables**

| 名称 | 值 |
|---|---|
| `DROPLET_HOST` | `167.99.86.19` |
| `DROPLET_PORT` | `2200` |
| `DROPLET_USER` | `deploy` |

镜像路径由 `github.repository` 自动推出（`ghcr.io/erichecan/veggie`），不用配。

</details>
