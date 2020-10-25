re='^[0-9]+$'
if ! [[ $1 =~ $re ]] ; then
	echo "error: no event ID given" >&2
	echo "Usage: sh $0 eventID" >&2
	exit 1
fi

for server in $(heroku apps | awk "/zxzyz"$1"/ {print \$1}")
do
	curl $server".herokuapp.com/slartyguts.html"
done

