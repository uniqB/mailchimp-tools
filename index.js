// Use bluebird over native promises.
global.Promise = require('bluebird');

const http = require('http');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

const axios = require('axios');

const mailchimpUrl = 'https://us12.api.mailchimp.com/3.0';
const maxItems = 2000;
const maxConn = 10;

function updateMember(apiKey, member, status) {
  return axios({
    method: 'patch',
    url: `${mailchimpUrl}/lists/${member.list_id}/members/${member.id}`,
    headers: { Authorization: `apikey ${apiKey}` },
    data: { status }
  })
    .then((response) => {
      console.log('update member success', member.id);
      return true;
    })
    .catch((error) => {
      console.log('update member error', member.id, error);
      return false;
    })
}

function serialUpdateMembers(apiKey, members, status) {
  return members.reduce((promiseChain, currentMember) => {
    return promiseChain.then(chainResults =>
      updateMember(apiKey, currentMember, status).then(currentResult => [...chainResults, currentResult])
    );
  }, Promise.resolve([]));
}

function updateMembers({ apiKey, listId, status, limit }) {
  // Find list by web_id
  return getListByWebId(apiKey, listId).then(currentList => {
    const listRealId = currentList.id;
    const oldStatus = status === 'subscribed' ? 'unsubscribed' : 'subscribed';
    const fields = status === 'subscribed' ? 'members.id,members.unsubscribe_reason' : 'members.id';
    const url = `${mailchimpUrl}/lists/${listRealId}/members?count=${Number(limit) || maxItems}&status=${oldStatus}&fields=${fields}`;

    return axios({
      method: 'get',
      url: url,
      headers: { Authorization: `apikey ${apiKey}` }
    }).then((response) => {
      let members = response.data.members;
      console.log(members);
      if (status === 'subscribed') {
        members = members.filter(m => !m.unsubscribe_reason || m.unsubscribe_reason === 'N/A (Unsubscribed by admin)');
      }

      members = members.map(m => {
        m.list_id = listRealId;
        return m;
      });

      const promises = [];
      const subLen = Math.ceil(members.length / maxConn);
      for (let i = 0; i < maxConn; i++) {
        const start = i * subLen;
        const end = Math.min((i + 1) * subLen, members.length);
        const subMembers = members.slice(start, end);
        promises.push(serialUpdateMembers(apiKey, subMembers, status));
        if (end === members.length) break;
      }

      return Promise.all(promises).then((result) => {
        const count = result.reduce((count, current) => count + current.filter(Boolean).length, 0);
        console.log('completed', count);
        return count;
      });
    });
  }).catch((error) => {
    console.log(error);
    return -1;
  })

}

function getListByWebId(apiKey, webId) {
  return axios({
    method: 'get',
    url: `${mailchimpUrl}/lists?fields=lists.id,lists.web_id`,
    headers: { Authorization: `apikey ${apiKey}` }
  }).then(response => {
    console.log(response.data.lists);
    const list = response.data.lists.find(l => l.web_id === Number(webId));
    return list || Promise.reject('unknown_web_id');
  });
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
  extended: true,
}));

app.get('/', function (req, res) {
  res.render('form', {
    status: null,
    data: {
      apiKey: null,
      listId: null,
      status: null,
      limit: maxItems
    }
  });
});

app.post('/', function (req, res) {
  console.log(req.body);
  if (req.body.apiKey && req.body.listId && req.body.status) {
    updateMembers(req.body).then(count => {
      res.render('form', { count, status: count >= 0 ? 'success' : 'error', data: req.body });
    });
  } else {
    res.render('form', { status: 'error', data: req.body });
  }
});

const port = process.env.PORT || 3000;
const server = http.createServer(app).listen(port, '0.0.0.0');
server.setTimeout(10 * 60 * 1000); // 10 mins
console.log(`Server started at port ${port}`);
