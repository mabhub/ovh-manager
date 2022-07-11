# OVH Api CLI tool

## Q&D installation

```shell
git clone https://github.com/mabhub/ovh-manager.git
cd ovh-manager
nvm use
npm i
ln -s index.mjs ~/bin/ovh
cp .env.dist .env.local
```

Create your first application tokens here: https://api.ovh.com/createToken/?GET=/me  
Then edit `.env.local`:

```env
DOMAIN=mydomain.com
APP_KEY=my_app_key
APP_SECRET=my_app_secret
```

then:

```
ovh auth
```

Copy `consumerKey`, navigate to `validationUrl` and validate authorization,  
Finally, paste `consumerKey` into `.env.local` for `CONSUMER_KEY`.
