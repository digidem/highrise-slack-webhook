var request = require('request')
var simpleParser = require('mailparser').simpleParser
var run = require('run-series')
var debug = require('debug')('highrise-slack:sync')
var once = require('once')

require('dotenv').config()

var Highrise = require('./highrise')

var config = {
  highriseToken: process.env.HIGHRISE_TOKEN,
  highriseUrl: process.env.HIGHRISE_URL.replace(/\/?$/, '/'),
  slackUrl: process.env.SLACK_URL,
  groups: (process.env.HIGHRISE_GROUPS || '').split(',').map(Number),
  showEveryone: (process.env.EVERYONE || '').toLowerCase() === 'true'
}

var recordingTypes = {
  email: 'an email',
  note: 'a note',
  comment: 'a comment'
}

var client = new Highrise(config.highriseUrl, config.highriseToken)

module.exports = function sync (lastCheck, cb) {
  client.get('recordings.xml', {since: lastCheck}, function (err, data) {
    if (err) return cb(err)
    debug('Found %d new recordings in Highrise', data.length)
    let msg = 'Filtering recordings of type ' + Object.keys(recordingTypes).join(', ')
    if (config.showEveryone) msg += ' that are visible to everyone'
    if (config.groups.length) msg += ' and visible to groups ' + config.groups.join(', ')
    debug(msg)

    var filteredData = data
      .filter(filterRecord)
      .sort(cmp('createdAt'))

    if (!filteredData.length) {
      debug('No matching recordings found')
      cb(null, lastCheck)
      return
    }

    debug(`Found ${filteredData.length} filtered recordings`)

    run(filteredData.map(r => cb => sendWebhook(r, cb)), done)

    function done (err, results) {
      if (err) return cb(err)
      debug('Sent ' + filteredData.length + ' new recordings to Slack')
      cb(null, data.sort(cmp('updatedAt'))[data.length - 1].updatedAt)
    }
  })

  function filterRecord (record) {
    // only post emails or notes or comments
    return (Object.keys(recordingTypes).includes(record.type)) &&
      // if visible to everyone & should show everyone
      ((record.visibleTo === 'Everyone' && config.showEveryone) ||
      // or visible to a group in HIGHRISE_GROUPS
      config.groups.indexOf(record.groupId) > -1) &&
      // only items creates since last check - edited record will not get re-posted
      record.createdAt > lastCheck
  }
}

function sendWebhook (recording, cb) {
  cb = once(cb)
  var pending = 2

  client.get('users/' + recording.authorId + '.xml', function (err, user) {
    if (err) {
      debug(`Error getting user ${recording.authorId}:
${JSON.stringify(user, null, 2)}`)
      return done(err)
    }
    recording.author = user
    done()
  })
  getSubject(recording.subjectId, getSubjectPath(recording.subjectType), function (err, subject) {
    if (err) {
      debug(`Error getting ${recording.subjectType} id: ${recording.subjectId}
${JSON.stringify(subject, null, 2)}`)
      return done(err)
    }
    recording.subject = subject
    done()
  })
  function done (err) {
    if (err) {
      debug(`Error processing recording ${recording.id}`)
      debug(err)
      // We just skip over records with an error, rather than stopping
      return cb()
    }
    if (--pending > 0) return

    formatWebhook(recording, function (err, payload) {
      if (err) return cb(err)
      request({
        url: config.slackUrl,
        method: 'POST',
        json: true,
        body: payload
      }, cb)
    })
  }
}

function formatWebhook (recording, cb) {
  var authorFirstName = recording.author.name.split(' ')[0]
  var recordingType = recordingTypes[recording.type] || 'a note'
  parseBody(recording, function (err, body) {
    if (err) return cb(err)
    var truncatedBody = truncate(body)
    var recordingLink = config.highriseUrl + recording.type + 's/' + recording.id
    var subjectLink = config.highriseUrl + getSubjectPath(recording.subjectType) + '/' + recording.subject.id
    if (truncatedBody !== body) {
      body = truncatedBody + ` <${recordingLink}|Read more…>`
    }
    var payload = {
      text: `${authorFirstName} shared <${recordingLink}|${recordingType}> ` +
        `about <${subjectLink}|${recording.subjectName}>`,
      username: 'highrise',
      icon_url: 'http://68.media.tumblr.com/avatar_079aaa3d2066_128.png',
      attachments: [{
        fallback: recording.body,
        text: body,
        ts: +recording.createdAt / 1000,
        mrkdwn_in: ['text', 'pretext']
      }]
    }
    if (recording.title) {
      payload.attachments[0].title = recording.title
      payload.attachments[0].title_link = `${config.highriseUrl}${recording.type}s/${recording.id}`
    }
    cb(null, payload)
  })
}

/**
 * @param {string} subjectId
 * @param {'people' | 'deals' | 'kases' | 'companies'} subjectPath
 * @param {Function} cb
 */
function getSubject(subjectId, subjectPath, cb) {
  client.get(subjectPath + '/' + subjectId + '.xml', function (err, subject) {
    if (err && subjectPath === 'people') {
      // 'Party' could be either a person or company
      return getSubject(subjectId, 'companies', cb)
    } else if (err) {
      return cb(err)
    }
    cb(null, subject)
  })
}

function parseBody (recording, cb) {
  if (recording.type === 'note') return cb(null, recording.body)
  const body = 'Content-Type: text/plain; charset=UTF-8\n\n' + recording.body
  simpleParser(body, function (err, mail) {
    if (err) return cb(err)
    cb(null, mail.text || recording.body || '')
  })
}

function truncate (text) {
  return text
  // if (text.length < 700 && text.split('\n').length < 5) return text
  // return text.split('\n').slice(0, 5).join('\n').slice(0, 700)
}

function getSubjectPath (type) {
  switch (type) {
    case 'Party':
      return 'people'
    case 'Deal':
      return 'deals'
    case 'Kase':
      return 'kases'
    default:
      return 'people'
  }
}

function cmp (prop) {
  return function (a, b) {
    return a[prop] > b[prop] ? 1 : a[prop] < b[prop] ? -1 : 0
  }
}
