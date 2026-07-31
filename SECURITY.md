# Security Policy

## Reporting a Vulnerability

Please **DO NOT** file a public issue for security vulnerabilities.

Instead, send a detailed report to **HuaweiCloudDeveloper@huawei.com**.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Any potential mitigations

We will acknowledge your report within **1 business day** and aim to provide a fix within **5 business days**.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |

## Security Best Practices

- Never commit AK/SK, tokens, or passwords to the repository
- Use environment variables for all credentials
- Review pull requests for credential exposure
- Keep dependencies up to date (monitored via `npm audit`)
