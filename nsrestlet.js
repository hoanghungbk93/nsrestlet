/*
    IMPORTED MODULES

    We use these four modules.
    
    Request is a pretty common module which simplifies http.request().  It may be replaced in the
    future as the version we are using is being deprecated.

    Oauth-1.0a is a module which does a lot of the encoding work for Oauth for us.  We used to use
    the 1.01 version, which had much simpler code, but we've gotten the newer version working now.
    As this module uses the crypto module, we now won't have to worry about the crypto going out of date,
    however, we will now need to emit an error now when the Node.JS they are using is built without crypto.

    QS turns JSON objects into query strings, for example, {id:12345, record:'salesord'} becomes
    'id=12345&record=salesord'.  This is useful for GET and DELETE requests

    Crypto is just the standard NodeJS crypto module built into the standard library
*/
const sha256 = require('crypto-js/sha256');
const hmacSHA256 = require('crypto-js/hmac-sha256');
const request = require('request');
const OAuth = require('oauth-1.0a');
const qs = require('qs');
const url = require('url');

//On very rare occasions, NodeJS can be built without the crypto module.  I dont' want to have to manage
//the security of cryptographic modules, so I'm just going to let NodeJS handle it and throw an error if
//the module doesn't exist (I can always direct users to version 1.0.1 of this module if they need it)


/*
    HELPER FUNCTIONS

    We use these functions throughout this file.  This just keeps them separated.

    The hash_function_sha256 function just performs the sha256 hash on a string.  It's written
    exactly like it's described in the oauth-1.0a documentaiton, so it's pretty simple.

    The has_error_message function checks to see if any of a list of errors are in an error
    message.  Pretty simple.
*/

function hash_function_sha256(base_string, key)
{
    const hashDigest = sha256(base_string);
    const hmacDigest = Base64.stringify(hmacSHA256(hashDigest, key));
    return hmacDigest
}

function has_error_message(error_message, errors)
{
    for(var index = 0; index < errors.length; index++)
    {
        if(error_message.indexOf(errors[index]) != -1)
        {
            return true;
        }
    }
    return false;
}

/*
    EXPORT

    The idea behind the export is that it should have a single method which you can use to create facades
    for a set of account settings and url settings.  It should look something like this:

    var nsrestlet = require('ns-restlet');
    var salesorders = nsrestlet.createLink(accountSettings, urlSettings);

    This allows users to reuse the accountSettings for other links, as well as reuse the urlSettings, which
    might be useful (if they mirror a sandbox account off of a production account?  is that possible?  not sure).
*/
module.exports = {

    createLink: function(accountSettings, urlSettings)
    {

        var authType, oauth;    //some variables we may need to use in the process

        /*
            ACCOUNT SETTINGS

            I wanted to make the account settings simple but flexible.  There are two ways to log in to Netsuite
            with a Restlet, and this module should cover both of them.
            
            The first, OAuth requires an Account ID, a Consumer Key-Secret Pair (Found on the Integrations page in
            Netsuite), and a Token Key-Secret Pair (Found on the Tokens page in Netsuite).

            The second, NLAuth requires a Username and Password.  It also allows us to specify a role, which isn't
            required but is highly reccomended.

            Generally OAuth is reccomended over NLAuth because tokens don't expire when password change and don't
            require you to mess with two-factor-authentication which requires you to verify them through your phone.

            This part basically just verifies that all that information is there as requried, or it throws an error.
        */

        if(!accountSettings)                //an accountSettings is required
        {
            throw new Error("Not enough information was provided to createLink().  You must provide an object with the account settings as the first argument.")
        }
        if(!accountSettings.accountId)      //an accountID is required
        {
            throw new Error("Not enough information was provided to createLink().  You must have an {accountId} to connect.")
        }
        //we need to determine the authorization type we are using
        //NLAuth uses {email, password} while OAuth v1 uses {tokenKey, tokenSecret, consumerKey, consumerSecret}   
        if(!accountSettings.tokenKey || !accountSettings.tokenSecret || !accountSettings.consumerKey || !accountSettings.consumerSecret)
        {
            //it's not OAuth...
            if(!accountSettings.email || !accountSettings.password) //email and password are required for NLAuth
            {
                throw new Error("Not enough information was provided to createLink().  You can connect via OAuth {tokenKey, tokenSecret, connsumerKey, consumerSecret} or NLAuth {email, password}.")
            }
            else
            {
                authType == "NLAuth";
            }
        }
        else
        {
            authType = "OAuth";        //OAuth v1 (not v2, netsuite doesn't do OAuth v2 yet)
            
            //the basic oauth object needs the consumer token and key, as well as the encoding type we are using
            oauth = OAuth({
                consumer: {
                    key: accountSettings.consumerKey,
                    secret: accountSettings.consumerSecret
                },
                signature_method: 'HMAC-SHA256',
                hash_function: hash_function_sha256
            })
        }

        /*
            URL SETTINGS

            I wanted to make this part flexible as well.  Most examples of OAuth restlet clients I have seen so far
            use the direct external URL.  This is great.  However, a NLAuth restlet client I saw, called nscabinet
            used a method to derive the URL from the Account ID, Script ID, and Script Deployment ID.  I decided I
            wanted this to work in the same way.

            In doing so, I discovered that the Script ID and Script Deployment ID could also be replaced by the Script
            Number and Deployment Number (actually, that's how the external URL is designed).  The section below accepts
            all of those options and just makes sure the correct arguments were passed in.  If not, it tosses an error.

            So your urlSettings object can look like either of the following:

            {
                url: https://ACCOUNTID.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=SCRIPTID&deploy=DEPLOYID
            }

            or

            {
                script: SCRIPTID,
                deployment: DEPLOYID
            }
        */

        if(!urlSettings)                                                            //urlSettings is required
        {
            throw new Error("Not enough information was provided to createLink().  You must provide either the URL or an object with {script, deployment} as the second argument")
        }

        if(!urlSettings.url && !(urlSettings.script && urlSettings.deployment))     //if there isn't a url or a {script,deployment}, toss an error
        {
            throw new Error("Not enough information was provided to createLink().  You must provide either the URL or an object with {script, deployment} as the second argument")
        }

        /*
            THE RESTLET CALL METHOD

            After you have created the link using createLink(accountSettings, urlSettings), you are returned a facade
            that contains get(), post(), put(), and delete().  You'll see these (and a description on how to use them)
            further down in the module.  All of these contain some common functionality though, which is contained in
            this function directly below (which happens to be the real meat of the module)

            This section does a few things.  First it sets up the headers.  The headers are a bit different depending
            on whether it's an OAuth or NLAuth call.
            
            If OAuth, we design an authorizaiton object which is encoded using the encoding specified earlier (in this
            case HMAC-SHA256).  This authorization object includes the Token Key-Secret Pair, the URL, and the HTTP
            method we are using (GET, POST, PUT, DELETE).  We add that, and your accountID to the header, and send it off.

            If instead we are doing NLAuth, your email and password are put into the header instead.  A role can also
            be added (and it's usually reccomended).  Bundle that up with the accountId, send it off, and you're good to go.

            There's are two other twist to this part though.  First, I wanted it to be both callback and promise friendly.
            This is done by detecting if there is a callback or not.  If there is, we use that callback.  If not, we return
            a promise that encapsulates this function.

            Secondly, I wanted the module to be able to retry on certain error as bknight's example code did.  So there's
            an inner function which allows this to happen.  I may move it so it's more readable in the future.
        */
        function callRestlet(method, payload, callback)
        {
            var makeCall;   //we'll be creating a function, and need a variable for it

            //if we don't have a callback, we create a promise that encapsulates this function
            //we may return a promise to the user, but internally we just use the callback form
            //when actually resolving things, which keeps all the code together in one
            if(!callback)
            {
                return new Promise(function(resolve, reject)
                {
                    callRestlet(method, payload, function(error, body)
                    {
                        if(error)
                        {
                            return reject(error)
                        }
                        else
                        {
                            resolve(body)
                        }
                    });
                });
            }
            //if there is a callback, we can proceed as normally
            else
            {
                //this is the inner function that contains all of the meaty code
                //it is called at the end of the function for the first time, and can be recalled
                //but only does so if certain errors are recieved
                makeCall = function makeCall(repeats)
                {
                    /*
                        GET NETSUITE URL

                        Please read about this function toards the end of this file.  It just gets
                        the correct Netsuite URL
                    */

                    getNetsuiteURL(accountSettings, urlSettings, function(urlToCall)
                    {
                        /*
                            ENCODE THE PAYLOAD

                            Data has to be sent to the Restlet somehow.  There are different ways data is sent
                            depending on what type of request is being made (GET, POST, PUT, or DELETE).
                            
                            With GET and DELETE requests, data is encoded into the URL using query paramaters
                            (you know, the part of some URLs you'll see that goes something like '?a=1&b=2&c=3').
                            This limits GET and DLETE to simple payloads like {a:1, b:2, c:3}.
                            
                            POST and PUT both put their data in what is called the body of the request.  This allows
                            you to send a JSON object with as much depth as you'd like.  Quite nice!
                        */
                    
                        var requestSettings = {};

                        //if we are doing get or delete, we need to encode the payload into a query string
                        if(method == "GET" || method == "DELETE")
                        {
                            urlToCall += "&" + qs.stringify(payload);
                        }
                        //otherwise, we need to attach it as json
                        else
                        {
                            requestSettings.json = payload;
                        }
                        //make sure to save the url to the requestSettings
                        requestSettings.url = urlToCall;

                        /*
                            SET THE AUTHORIZATION

                            We already talked a bit about the Authorization above (so read that for details).
                            This section creates the OAuth or NLAUth headers that we need to make a call to
                            the Restlet.  For both we need quite a bit of data, so I didn't seperate them into
                            their own function.  I might do that in the future though.
                        */

                        var headers;

                        if(authType == "OAuth")     //if we are doing OAuth
                        {
                            //encode an authorization of the following data using HMAC-SHA256
                            var authorization = oauth.authorize({
                                url: urlToCall,
                                method: method  },{
                                key: accountSettings.tokenKey,
                                secret: accountSettings.tokenSecret
                            })

                            //stick it and the other stuff we need in the header
                            headers = oauth.toHeader(authorization);
                            headers.Authorization += ', realm="' + accountSettings.accountId + '"';

                        }
                        else                        //if we are doing NLAUTH
                        {
                            //stick the necessary stuff in the header
                            headers = { Authorization: '' }
                            headers.Authorization += 'NLAuth nlauth_account=' + accountSettings.accountId;
                            headers.Authorization += ',nlauth_email=' + accountSettings.email;
                            headers.Authorization += ',nlauth_signature=' + accountSettings.password;

                            //role is optional (but reccomended)
                            if(accountSettings.role)
                            {
                                headers.Authorization += ',nlauth_role=' + accountSettings.role
                            }
                        }

                        /*
                            JUST SOME EXTRA STUFF

                            We need to add a content-type, method, and headers to the request.
                            Not much else.
                        */

                        //we are using application/json, which will pretty much always work for what people want
                        headers['content-type'] = 'application/json';

                        //set up the request settings
                        requestSettings.method = method;
                        requestSettings.headers = headers;

                        /*
                            MAKE THE REQUEST

                            We finally get to make the request.  Once we make the request, we either pass back the
                            data or if we got an error, we do some checking.  If we get an error that we can retry,
                            we do some after some optional user provided backoff.  Otherwise, we pass back an error.
                        */

                        //make the actual request
                        getDataFromNetsuite(requestSettings, method, function(actual_error, error_message, actual_body)
                        {
                            //if there was an error
                            if(error_message)
                            {
                                //if we got an error that we can try again, and we haven't reached our repeat limit, try again
                                //otherwise throw an error
                                //largely gotten from bknight's code (see readme)
                                if(has_error_message(error_message, ['ECONNRESET', 'ESOCKETTIMEDOUT','ETIMEDOUT', 'SSS_REQUEST_LIMIT_EXCEEDED']))
                                {
                                    if(repeats > 0)
                                    {
                                        if(urlSettings.backoff && urlSettings.retries)
                                        {
                                            setTimeout(function()
                                            {
                                                makeCall(repeats - 1);
                                            }, urlSettings.backoff * (urlSettings.retries - (repeats + 1)));
                                        }
                                        else
                                        {
                                            makeCall(repeats - 1);
                                        }
                                    }
                                    else
                                    {
                                        callback(actual_error);
                                    }
                                }
                                else
                                {
                                    callback(actual_error);
                                }
                            }
                            else
                            {
                                //we got a correct response - return the body
                                //(because we don't care about the headers and all that stuff, just the data)
                                callback(undefined, actual_body);
                            }
                        });

                    });
                }
                //make the call to the function - we can retry up to three times
                var amount_of_calls = 3;
                if(urlSettings.retries)
                {
                    amount_of_calls = urlSettings.retries;
                }
                makeCall(amount_of_calls);
            }
        }

        /*
            HTTP METHOD FACADE

            Here we set up some facade methods which all eventually redirect to callRestlet().  This idea came
            from some wonderful sample code by BKnights.  They facade methods can be used like this:

            var nsrestlet = require('ns-restlet');
            var salesorders = nsrestlet.createLink(accountSettings, urlSettings);
            salesorders.get(payload, function(error, response)
            {
                console.log(error, response);
            })

            Or you can use them like this:

            var nsrestlet = require('ns-restlet');
            var salesorders = nsrestlet.createLink(accountSettings, urlSettings);
            var myPromise = salesorders.post(payload)
            myPromise.then(function(error, response)
            {
                console.log(error, response);
            })

            As you can see, that they are pretty straighforward.  This is the object that actually gets returned
            to the user (they can't use callRestlet() directly)
        */
        return {
            get: function(payload, callback)
            {
                return callRestlet("GET", payload, callback);
            },
            post: function(payload, callback)
            {
                return callRestlet("POST", payload, callback);
            },
            put: function(payload, callback)
            {
                return callRestlet("PUT", payload, callback);
            },
            delete: function(payload, callback)
            {
                return callRestlet("DELETE", payload, callback);
            }
        }
    }

}

/*
    GET THE NETSUITE URL

    We use this method to get the URL we will call the Restlet from.  Why do we do this if a user already gives
    us the URL?  It's because Netsuite's URL format may change in the future.  We want this module to be as
    future-proof as possible.  Ideally, even if Netsuite changes the URL, they shouldn't need to change the URL
    they give or update their appliation at all.

    This function allows that by calling an endpoint Netsuite has.  A GET request to the endpoint will give us
    the correct REST domain for the account (even if Netsuite changes what that domain is in the future).
*/
function getNetsuiteURL(accountSettings, urlSettings, callback)
{
    //call the endpoint with GET and the Account ID
    var requestSettings = {
        url: 'https://rest.netsuite.com/rest/datacenterurls?' + qs.stringify({account:accountSettings.accountId}),
        json: true,
        method: "GET"
    }
    request(requestSettings, function(error, response, body)
    {
        var has_error = false;

        //occasionally there is a Network error that we have to catch
        /* istanbul ignore if  */      //but we also have to ignore it in code coverage because it's really hard to test
        if(error)
        {
            has_error = true;
        }
        //if there wasn't a network error...
        else
        {
            //check and see if we had a Netsuite body error
            /* istanbul ignore next  */      //again, we have to ignore this in code coverage because it's hard to test (this one might even never happen due to the way the endpoint works actually)
            if(body.error && body.error.code)
            {
                has_error = true;
            }
        }

        //next, prepare to design a URL
        var urlToCall;

        //if there was an error
        /* istanbul ignore if  */      //because it's so hard to get either of the errors above, we have to ignore this section in code coverage as well
        if(has_error)
        {
            //we need to create the URL string manually
            //we can do this by...

            if(urlSettings.url)                                     //using the URL provided to us
            {
                urlToCall = urlSettings.url;
            }
            else if(urlSettings.script && urlSettings.deployment)   //or given a {script, deployment}, and {accountId}, designing the URL from scratch
            {
                urlToCall = 'https://' + accountSettings.accountId + '.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=' + urlSettings.script + '&deploy=' + urlSettings.deployment;
            }
        }
        //if there was no error (the call was succesful)
        else
        {
            //get the rest domain from the endpoint
            urlToCall = body.restDomain + "/app/site/hosting/restlet.nl";

            /* istanbul ignore else  */     //here we have an if, else if, and then skip the else.  It's impossible to reach that else, so we skip it in code coverage.
            if(urlSettings.url)                                     //if a URL was provided, we need to get the search paramaters, and append them to our REST domain
            {
                var urlObj = url.parse(urlSettings.url);
                urlToCall += urlObj.search;
            }
            else if(urlSettings.script && urlSettings.deployment)   //if a {script, deployment}, was provided, we can append those instead
            {
                urlToCall += '?script=' + urlSettings.script + '&deploy=' + urlSettings.deployment;
            }
        }

        //now that we have the URL, we can give it to the callback
        callback(urlToCall);
    });
}

/*
    GET DATA FROM NETSUITE

    We use this method to normalize the Netsuite Restlet call.  Mainly, we want to get the error data in the
    correct format.  Besies that, there isn't much else that's important to this.
*/
function getDataFromNetsuite(requestSettings, method, callback)
{
    //make the call to the Restlet
    request(requestSettings, function(error, response, body)
    {
        //there are two types of errors we can recieve, Network errors, and Netsuite errors

        //for network errors...
        /* istanbul ignore if  */      //we can't simulate a Network error, so we have to ignore this in code coverage
        if(error)
        {
            var error_message = actual_error.message || JSON.stringify(actual_error);
            callback(error, error_message);
        }
        //if there isn't a network error...
        else
        {
            //we need to get the body
            var actual_body = body;

            if(actual_body != '' && (method == "GET" || method == "DELETE"))    //for GET and DELETE, we need to parse the data form a string
            {
                actual_body = JSON.parse(actual_body);
            }

            //if there's a Netsuite error, call it back
            if(actual_body.error && actual_body.error.code)
            {
                var actual_error = actual_body.error;
                callback(actual_error, actual_error.code);
            }
            //otherwise call the body back
            else
            {
                callback(undefined, undefined, actual_body);
            }
        }
    });
}