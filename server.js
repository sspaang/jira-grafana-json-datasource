const express = require('express')
const bodyParser = require('body-parser')
const app = express()
const JiraClient = require('jira-connector')
const morgan = require('morgan')
const passport = require('passport')
const BasicStrategy = require('passport-http').BasicStrategy
const AnonymousStrategy = require('passport-anonymous')

// Instantiate our Jira client
const jira = new JiraClient({
    host: process.env.JIRA_HOST,
    basic_auth: {
        email: process.env.JIRA_USER,
        api_token: process.env.JIRA_API_TOKEN,
    },
})

// Setup an authentication strategy
let authenticationStrategy = null
if (process.env.HTTP_USER) {
    passport.use(
        new BasicStrategy(function (username, password, done) {
            if (
                process.env.HTTP_USER == username &&
                process.env.HTTP_PASS == password
            ) {
                return done(null, true)
            }

            return done(null, false)
        })
    )

    authenticationStrategy = 'basic'
} else {
    // Default ot allowing anonymous access
    passport.use(new AnonymousStrategy())
    authenticationStrategy = 'anonymous'
}

app.use(bodyParser.json())
app.use(morgan('combined')) // We want to log all HTTP requests
app.use(passport.initialize())

// Should return 200 ok. Used for "Test connection" on the datasource config page.
app.get(
    '/',
    passport.authenticate(authenticationStrategy, { session: false }),
    (httpReq, httpRes) => {
        httpRes.set('Content-Type', 'text/plain')
        httpRes.send(new Date() + ': OK')
    }
)

// Test the connection between Jira and this project
app.get(
    '/test-jira',
    passport.authenticate(authenticationStrategy, { session: false }),
    (httpReq, httpRes) => {
        jira.myself
            .getMyself()
            .then((jiraRes) => {
                httpRes.json(jiraRes)
            })
            .catch((jiraErr) => {
                httpRes.json(JSON.parse(jiraErr))
            })
    }
)

// Used by the find metric options on the query tab in panels.
app.all(
    '/search',
    passport.authenticate(authenticationStrategy, { session: false }),
    (httpReq, httpRes) => {
        jira.filter.getFavoriteFilters().then((jiraRes) => {
            let result = jiraRes.map((filter) => {
                return {
                    text: filter.name,
                    value: filter.id,
                }
            })

            httpRes.json(result)
        })
    }
)

// Should return metrics based on input.
app.post(
    '/query',
    passport.authenticate(authenticationStrategy, { session: false }),
    (httpReq, httpRes) => {
        let result = []

        // Convert proper formatted Grafana data into the Jira mess
        let from = new Date(httpReq.body.range.from)
            .toISOString()
            .replace(/T/, ' ')
            .replace(/\:([^:]*)$/, '')
        let to = new Date(httpReq.body.range.to)
            .toISOString()
            .replace(/T/, ' ')
            .replace(/\:([^:]*)$/, '')

        let p = httpReq.body.targets.map((target) => {
            // Default jql with time range
            let jql = [`created >= "${from}"`, `created <= "${to}"`]

            // Additional jql for targets
            if (target.target) {
                jql.push(`filter = "${target.target}"`)
            }

            return jira.search
                .search({
                    jql: jql.join(' AND '),
                })
                .then((jiraRes) => {
                    if (target.type == 'timeserie') {
                        let datapoints = jiraRes.issues.map((issue) => {
                            timestamp = Math.floor(
                                new Date(issue.fields.created)
                            )
                            return [1, timestamp]
                        })

                        result.push({
                            target: target.target,
                            datapoints: datapoints,
                        })
                    } else if (target.type == 'table') {
                        let rows = jiraRes.issues.map((issue) => {
                            return [
                                issue.key,
                                issue.fields.summary,
                                issue.fields.assignee
                                    ? issue.fields.assignee.displayName
                                    : '',
                                issue.fields.status
                                    ? issue.fields.status.name
                                    : '',
                                issue.fields.created,
                            ]
                        })

                        result.push({
                            columns: [
                                { text: 'Key', type: 'string' },
                                { text: 'Summary', type: 'string' },
                                { text: 'Assignee', type: 'string' },
                                { text: 'Status', type: 'string' },
                                { text: 'Created', type: 'time' },
                            ],
                            type: 'table',
                            rows: rows,
                        })
                    }
                })
        })

        // Once all promises resolve, return result
        Promise.all(p).then(() => {
            httpRes.json(result)
        })
    }
)

app.listen(3000)

console.log('Server is listening to port 3000')
