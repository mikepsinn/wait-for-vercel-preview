// @ts-check
// Dependencies are compiled using https://github.com/vercel/ncc
// noinspection ExceptionCaughtLocallyJS

const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');
const setCookieParser = require('set-cookie-parser');

const calculateIterations = (maxTimeoutSec, checkIntervalInMilliseconds) =>
  Math.floor(maxTimeoutSec / (checkIntervalInMilliseconds / 1000));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForUrl = async ({
  url,
  maxTimeout,
  checkIntervalInMilliseconds,
  vercelPassword,
  path,
  authUrl
}) => {
  const iterations = calculateIterations(
    maxTimeout,
    checkIntervalInMilliseconds
  );

  for (let i = 0; i < iterations; i++) {
    try {
      let headers = {'Accept-Encoding': 'gzip,deflate,compress'}; // Needed to deal with https://bobbyhadz.com/blog/javascript-axioserror-unexpected-end-of-file#:~:text=The%20%22AxiosError%3A%20unexpected%20end%20of,back%20to%20axios%20version%201.1.

      if (vercelPassword) {
        const jwt = await getPassword({
          url,
          vercelPassword,
        });

        headers.Cookie = `_vercel_jwt=${jwt}`

        core.setOutput('vercel_jwt', jwt);
      }

      let checkUri = new URL(path, url);
      let appUrlWithPath = checkUri.toString();
      console.log(`Getting appUrl: ${appUrlWithPath}`);
      await axios.get(appUrlWithPath, {
        headers,
      });
      console.log(`Received success status code from appUrlWithPath ${appUrlWithPath}`);

      let authCheckUri = new URL(path, authUrl);
      let authUrlWithPath = authCheckUri.toString();
        console.log(`Getting Auth URL: ${authUrlWithPath}`);
      await axios.get(authUrlWithPath, {
        headers,
      });

      console.log(`Received success status code from authUrlWithPath ${authUrlWithPath}`);
      return;
    } catch (e) {
      // https://axios-http.com/docs/handling_errors
      if (e.response) {
        console.log(
          `GET status: ${e.response.status}. Attempt ${i} of ${iterations}`
        );
      } else if (e.request) {
        console.log(
          `GET error. A request was made, but no response was received. Attempt ${i} of ${iterations}`
        );
        console.log(e.message);
      } else {
        console.log(e);
      }

      await wait(checkIntervalInMilliseconds);
    }
  }

  core.setFailed(`Timeout reached: Unable to connect to ${url}`);
};

/**
 * See https://vercel.com/docs/errors#errors/bypassing-password-protection-programmatically
 * @param {{url: string; vercelPassword: string }} options vercel password options
 * @returns {Promise<string>}
 */
const getPassword = async ({ url, vercelPassword }) => {
  console.log('requesting vercel JWT');

  const data = new URLSearchParams();
  data.append('_vercel_password', vercelPassword);

  const response = await axios({
    url,
    method: 'post',
    data: data.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    maxRedirects: 0,
    validateStatus: (status) => {
      // Vercel returns 303 with the _vercel_jwt
      return status >= 200 && status < 307;
    },
  });

  const setCookieHeader = response.headers['set-cookie'];

  if (!setCookieHeader) {
    throw new Error('no vercel JWT in response');
  }

  const cookies = setCookieParser(setCookieHeader);

  const vercelJwtCookie = cookies.find(
    (cookie) => cookie.name === '_vercel_jwt'
  );

  if (!vercelJwtCookie || !vercelJwtCookie.value) {
    throw new Error('no vercel JWT in response');
  }

  console.log('received vercel JWT');

  return vercelJwtCookie.value;
};

const waitForStatus = async ({
  token,
  owner,
  repo,
  deployment_id,
  maxTimeout,
  allowInactive,
  checkIntervalInMilliseconds,
}) => {
  const octokit = new github.getOctokit(token);
  const iterations = calculateIterations(
    maxTimeout,
    checkIntervalInMilliseconds
  );

  for (let i = 0; i < iterations; i++) {
    try {
      const statuses = await octokit.rest.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id,
      });

      const status = statuses.data.length > 0 && statuses.data[0];

      if (!status) {
        throw new StatusError('No status was available');
      }

      if (status && allowInactive === true && status.state === 'inactive') {
        return status;
      }

      if (status && status.state !== 'success') {
        throw new StatusError('No status with state "success" was available');
      }

      if (status && status.state === 'success') {
        return status;
      }

      throw new StatusError('Unknown status error');
    } catch (e) {
      console.log(
        `Deployment unavailable or not successful, retrying (attempt ${
          i + 1
        } / ${iterations})`
      );
      if (e instanceof StatusError) {
        if (e.message.includes('No status with state "success"')) {
          // TODO: does anything actually need to be logged in this case?
        } else {
          console.log(e.message);
        }
      } else {
        console.log(e);
      }
      await wait(checkIntervalInMilliseconds);
    }
  }
  core.setFailed(
    `Timeout reached: Unable to wait for an deployment to be successful`
  );
};

class StatusError extends Error {
  constructor(message) {
    super(message);
  }
}

/**
 * Waits until the github API returns a deployment for
 * a given actor.
 *
 * Accounts for race conditions where this action starts
 * before the actor's action has started.
 *
 * @returns
 */
const waitForDeploymentToStart = async ({
  octokit,
  owner,
  repo,
  sha,
  environment,
  actorName = 'vercel[bot]',
  maxTimeout = 20,
  checkIntervalInMilliseconds = 2000,
  authServer
}) => {
  const iterations = calculateIterations(
    maxTimeout,
    checkIntervalInMilliseconds
  );

  for (let i = 0; i < iterations; i++) {
    try {
      const deployments = await octokit.rest.repos.listDeployments({
        owner,
        repo,
        sha,
        environment,
      });
      console.log("deployments.data", deployments.data);

      const deployment =
        deployments.data.length > 0 &&
        deployments.data.find((deployment) => {
          if(deployment.creator.login !== actorName) {
            return false;
          }
          if(authServer){
            return deployment.environment.includes('auth-');
          } else {
            return !deployment.environment.includes('auth-');
          }
        });

      if (deployment) {
        return deployment;
      }

      console.log(
        `Could not find any deployments for actor ${actorName}, retrying (attempt ${
          i + 1
        } / ${iterations})`
      );
    } catch(e) {
      console.log(
        `Error while fetching deployments, retrying (attempt ${
          i + 1
        } / ${iterations})`
      );

      console.error(e)
    }

    await wait(checkIntervalInMilliseconds);
  }

  return null;
};

async function getShaForPullRequest({ octokit, owner, repo, number }) {
  const PR_NUMBER = github.context.payload.pull_request.number;

  if (!PR_NUMBER) {
    core.setFailed('No pull request number was found');
    return;
  }

  // Get information about the pull request
  const currentPR = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: PR_NUMBER,
  });

  if (currentPR.status !== 200) {
    core.setFailed('Could not get information about the current pull request');
    return;
  }

  // Get Ref from pull request
  const prSHA = currentPR.data.head.sha;

  return prSHA;
}

const run = async () => {
  try {
    // Inputs
    const GITHUB_TOKEN = core.getInput('token', { required: true });
    const VERCEL_PASSWORD = core.getInput('vercel_password');
    const ENVIRONMENT = core.getInput('environment');
    const MAX_TIMEOUT = Number(core.getInput('max_timeout')) || 60;
    const ALLOW_INACTIVE = Boolean(core.getInput('allow_inactive')) || false;
    const PATH = core.getInput('path') || '/';
    const CHECK_INTERVAL_IN_MS =
      (Number(core.getInput('check_interval')) || 2) * 1000;

    // Fail if we have don't have a github token
    if (!GITHUB_TOKEN) {
      core.setFailed('Required field `token` was not provided');
    }

    const octokit = github.getOctokit(GITHUB_TOKEN);

    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    /**
     * @type {string}
     */
    let sha;

    if (github.context.payload && github.context.payload.pull_request) {
      sha = await getShaForPullRequest({
        octokit,
        owner,
        repo,
        number: github.context.payload.pull_request.number,
      });
    } else if (github.context.sha) {
      sha = github.context.sha;
    }

    if (!sha) {
      core.setFailed('Unable to determine SHA. Exiting...');
      return;
    }

    // Get deployments associated with the pull request.
    const appDeployment = await waitForDeploymentToStart({
      octokit,
      owner,
      repo,
      sha: sha,
      environment: ENVIRONMENT,
      actorName: 'vercel[bot]',
      maxTimeout: MAX_TIMEOUT,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
      authServer: false
    });

    // Get deployments associated with the pull request.
    const authDeployment = await waitForDeploymentToStart({
      octokit,
      owner,
      repo,
      sha: sha,
      environment: ENVIRONMENT,
      actorName: 'vercel[bot]',
      maxTimeout: MAX_TIMEOUT,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
      authServer: true
    });

    if (!appDeployment) {
      core.setFailed('no vercel appDeployment found, exiting...');
      return;
    }

    if (!authDeployment) {
      core.setFailed('no vercel authDeployment found, exiting...');
      return;
    }

    const appStatus = await waitForStatus({
      owner,
      repo,
      deployment_id: appDeployment.id,
      token: GITHUB_TOKEN,
      maxTimeout: MAX_TIMEOUT,
      allowInactive: ALLOW_INACTIVE,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    });

    const authStatus = await waitForStatus({
      owner,
      repo,
      deployment_id: authDeployment.id,
      token: GITHUB_TOKEN,
      maxTimeout: MAX_TIMEOUT,
      allowInactive: ALLOW_INACTIVE,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    });

    // Get target url
    const appTargetUrl = appStatus.target_url;

    const authTargetUrl = authStatus.target_url;

    if (!appTargetUrl) {
      core.setFailed(`no appStatus.target_url found in the status check`);
      return;
    }

    if (!authTargetUrl) {
        core.setFailed(`no authStatus.target_url found in the status check`);
        return;
    }

    console.log('app_url »', appTargetUrl);
    console.log('auth_url »', authTargetUrl);

    // Set output
    core.setOutput('app_url', appTargetUrl);
    core.setOutput('auth_url', authTargetUrl);

    // Wait for url to respond with a success
    console.log(`Waiting for a status code 200 from: ${appTargetUrl} and ${authTargetUrl}`);

    await waitForUrl({
      url: appTargetUrl,
      maxTimeout: MAX_TIMEOUT,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
      vercelPassword: VERCEL_PASSWORD,
      path: PATH,
      authUrl: authTargetUrl
    });
  } catch (error) {
    core.setFailed(error.message);
  }
};

exports.run = run;
