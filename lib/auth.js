const config = require('./config');
const AmazonCognitoIdentity = require('amazon-cognito-identity-js');

const {
    CognitoIdentityClient,
    GetIdCommand,
    GetCredentialsForIdentityCommand,
} = require('@aws-sdk/client-cognito-identity');


global.fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));

function authenticate(_username, _password, _region) {
    const poolData = {
        UserPoolId: config.cognito.UserPoolId,
        ClientId: config.cognito.ClientId,
    };

    const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

    const userData = {
        Username: _username,
        Pool: userPool,
    };

    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
        Username: _username,
        Password: _password,
    });

    const cognitoUser = new AmazonCognitoIdentity.CognitoUser(userData);

    return new Promise((resolve, reject) => {
        try {
            cognitoUser.authenticateUser(authDetails, {
                onSuccess: async (result) => {
                    try {
                        const idToken = result.getIdToken().getJwtToken();
                        const accessToken = result.getAccessToken().getJwtToken();

                        const cognitoClient = new CognitoIdentityClient({ region: _region });

                        const logins = {
                            [`cognito-idp.${_region}.amazonaws.com/${config.cognito.UserPoolId}`]: idToken,
                        };

                        const { IdentityId } = await cognitoClient.send(
                            new GetIdCommand({
                                IdentityPoolId: config.cognito.IdentityPoolId,
                                Logins: logins,
                            })
                        );

                        const { Credentials } = await cognitoClient.send(
                            new GetCredentialsForIdentityCommand({
                                IdentityId,
                                Logins: logins,
                            })
                        );

                        resolve({
                            accessKeyId: Credentials.AccessKeyId,
                            secretAccessKey: Credentials.SecretKey,
                            sessionToken: Credentials.SessionToken,
                            accessToken,
                        });
                    } catch (err) {
                        console.error('AWS Credential Error:', err);
                        reject(new Error('Fehler beim Abrufen der AWS-Credentials: ' + err.message));
                    }
                },

                onFailure: (err) => {
                    console.error('Cognito Auth Error:', err);
                    reject(new Error('Authentifizierung fehlgeschlagen: ' + err.message));
                },
            });
        } catch (outerErr) {
            console.error('Unerwarteter Auth-Fehler:', outerErr);
            reject(new Error('Fehler bei der Authentifizierung: ' + outerErr.message));
        }
    });
}

module.exports = authenticate;