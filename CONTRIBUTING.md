# Contributing

Thanks for your interest.

This public repository accepts:

- Documentation fixes
- Typo / README improvements
- Discussion on public roadmap items

It does **not** accept:

- Patches that claim to be the production client
- Secrets, tokens, or private config
- Binary blobs larger than policy allows

### Dev setup

```bash
npm install
npm run lint
npm test
```

### PR checklist

- [ ] No secrets
- [ ] CI green
- [ ] Docs updated if behavior changed
