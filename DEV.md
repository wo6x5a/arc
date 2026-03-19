# 开发备忘

## 重新打包并发布 npm

```bash
# 1. 改版本号（会自动 commit + tag）
npm version patch   # 小改动 1.0.1 -> 1.0.2
npm version minor   # 新功能 1.0.1 -> 1.1.0
npm version major   # 不兼容 1.0.1 -> 2.0.0

# 2. 发布到 npm
npm publish

# 3. 推送 tag 到 git（可选）
git push && git push --tags
```

## 本地验证打包内容

```bash
# 查看哪些文件会被打进包里
npm pack --dry-run
```

## 用户更新到最新版

```bash
npm install -g arc-bot@latest
```
